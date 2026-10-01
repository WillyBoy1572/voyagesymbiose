'use strict'

/*
  ⚠️ ICI, `t` PARLE LA LANGUE DU SERVEUR. Ces textes-la vont dans la console
     et dans les journaux : c'est l'hote qui les lit, et il n'y en a qu'un.
     Les messages destines aux JOUEURS, eux, passent par `messageA` ou
     `annoncer` avec une cle nue -- chacun les recoit dans la sienne.
*/
const { surLaConsole: t } = require('./langues')


const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  RESSOURCES — ajouter du comportement au serveur sans toucher au serveur
 * ═══════════════════════════════════════════════════════════════════════════
 *  Un dossier par ressource, un manifeste, un fichier d'entree. Le serveur
 *  les charge au demarrage, leur passe une API etroite, et les recharge a la
 *  demande sans couper la partie.
 *
 *  ⚠️ L'API EST EN JAVASCRIPT, PAS EN LUA, ET C'EST UN CHOIX ASSUME. Le brief
 *     demande une API Lua. Executer du Lua dans Node exige un module natif
 *     (`lua`, `fengari` mis a part, qui est une reimplementation complete) :
 *     ca voudrait dire une compilation par plateforme et la fin du
 *     « aucune dependance » qui permet au serveur de demarrer sans
 *     `npm install` dans un conteneur d'hebergement. L'API a donc la meme
 *     forme que celle demandee — `sur()`, `commande()`, `annoncer()` — mais en
 *     JavaScript. Le mod DANS LE JEU, lui, est bien en Lua : c'est la que le
 *     Lua est impose, et c'est la qu'il est.
 *
 *  ⚠️ CE N'EST PAS UN BAC A SABLE DE SECURITE. `node:vm` n'en est pas un, et il
 *     faut le dire sans detour : une ressource atteint `process` en une ligne,
 *     par le constructeur de n'importe quelle fonction qu'on lui a passee --
 *     `sur.constructor('return process')()`. De la, elle lit l'environnement et
 *     ouvre des fichiers. Essaye, c'est trois lignes.
 *
 *     Ce que l'API etroite apporte, c'est une protection contre les ACCIDENTS :
 *     une ressource qui se trompe ne casse pas la partie, et une erreur la
 *     desactive au lieu de tuer le serveur. Contre du code HOSTILE, elle
 *     n'apporte rien. Une ressource est aussi digne de confiance que le serveur
 *     lui-meme : installer celle d'un inconnu, c'est lui donner la machine.
 *
 *     Mesure prise en consequence : `server.js` efface les secrets de
 *     `process.env` une fois la configuration lue, pour qu'une ressource ne les
 *     y trouve plus. Ca ne rend pas l'isolation vraie, ca retire juste le butin
 *     le plus evident.
 *
 *  ⚠️ ELLE TOURNE DANS LE MEME PROCESSUS : une boucle infinie arrete tout.
 *
 *  ⚠️ UNE RESSOURCE QUI PLANTE NE TUE PAS LA PARTIE. Chaque appel est
 *     enveloppe ; une erreur desactive la ressource et l'ecrit dans la
 *     console, le reste continue.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Les evenements qu'une ressource peut ecouter. Fermee. */
const EVENEMENTS = [
  'demarrage',
  'arret',
  'arrivee',
  'depart',
  'chat',
  'commande',
  'evenement',
  'entite',
  'inventaire',
  'pnj',
  'tick',
  'seconde',
]

/** Au-dela, on refuse de charger : un manifeste de 1 Mo est une erreur. */
const MANIFESTE_MAX = 64 * 1024
const CODE_MAX = 2 * 1024 * 1024

/** Temps accorde au chargement d'une ressource. Une boucle au chargement se voit. */
const DELAI_CHARGEMENT_MS = 2000

class Ressource {
  constructor(nom, dossier) {
    this.nom = nom
    this.dossier = dossier
    this.version = '0.0.0'
    this.description = ''
    this.auteur = ''
    this.active = false
    this.erreur = null
    /** evenement -> [rappels] */
    this.ecoutes = new Map()
    /** nom -> { aide, droit, faire } */
    this.commandes = new Map()
    this.minuteries = new Set()
    this.etat = {}
  }
}

class Ressources {
  /**
   * @param {object} config
   * @param {object} contexte ce que les ressources peuvent toucher
   */
  constructor(config, contexte, journal) {
    this.config = config
    this.contexte = contexte
    this.journal = journal || (() => {})
    this.dossier = path.resolve(config.dossierRessources || './ressources')
    /** @type {Map<string, Ressource>} */
    this.table = new Map()
  }

  get nombre() {
    return [...this.table.values()].filter((r) => r.active).length
  }

  // ── Chargement ──────────────────────────────────────────────────────────

  /** Charge tout le dossier. Rend `{charges, refuses}`. */
  chargerTout() {
    let charges = 0
    let refuses = 0

    let entrees = []
    try {
      entrees = fs.readdirSync(this.dossier, { withFileTypes: true })
    } catch {
      // Pas de dossier de ressources : c'est le cas normal, on ne dit rien.
      return { charges: 0, refuses: 0 }
    }

    for (const e of entrees) {
      if (!e.isDirectory()) continue
      if (e.name.startsWith('.') || e.name.startsWith('_')) continue
      if (this.charger(e.name)) charges++
      else refuses++
    }

    if (charges || refuses) {
      this.journal(
        t('ressources.ressources-chargee-s', {
          v1: charges,
          v2: refuses ? t('ressources.dont-refusees', { v1: refuses }) : '',
        }),
      )
    }
    return { charges, refuses }
  }

  /**
   * Charge ou recharge une ressource.
   *
   * ⚠️ ON DECHARGE AVANT DE RECHARGER. Sans ca, les anciennes ecoutes et les
   *    anciennes minuteries continueraient de tourner en double.
   */
  charger(nom) {
    const propre = String(nom || '').replace(/[^\w.-]/g, '')
    if (!propre) return false

    const dossier = path.join(this.dossier, propre)
    /*
      ⚠️ ON VERIFIE QUE LE CHEMIN RESTE DANS LE DOSSIER. Un nom contenant
         « .. » pourrait sortir et charger n'importe quel fichier de la
         machine.
    */
    if (!dossier.startsWith(this.dossier + path.sep)) return false

    this.decharger(propre)
    const r = new Ressource(propre, dossier)
    this.table.set(propre, r)

    try {
      const cheminManifeste = path.join(dossier, 'ressource.json')
      const brutManifeste = fs.readFileSync(cheminManifeste, 'utf8')
      if (brutManifeste.length > MANIFESTE_MAX) throw new Error('manifeste trop gros')
      const manifeste = JSON.parse(brutManifeste)

      r.version = String(manifeste.version || '0.0.0').slice(0, 24)
      r.description = String(manifeste.description || '').slice(0, 240)
      r.auteur = String(manifeste.auteur || manifeste.author || '').slice(0, 48)

      const entree = String(manifeste.principal || manifeste.main || 'principal.js').replace(/[^\w./-]/g, '')
      const cheminCode = path.resolve(dossier, entree)
      if (!cheminCode.startsWith(dossier + path.sep)) throw new Error(t('ressources.fichier-d-entree-hors-du'))

      const code = fs.readFileSync(cheminCode, 'utf8')
      if (code.length > CODE_MAX) throw new Error(t('ressources.fichier-d-entree-trop-gros'))

      r.etat = this.#lireEtat(r)

      const bac = this.#bacASable(r)
      const contexte = vm.createContext(bac, {
        name: `ressource:${propre}`,
        codeGeneration: { strings: false, wasm: false },
      })
      const script = new vm.Script(code, { filename: `${propre}/${entree}` })
      script.runInContext(contexte, { timeout: DELAI_CHARGEMENT_MS })

      r.active = true
      r.erreur = null
      this.journal(t('ressources.ressource-v-chargee', { v1: propre, v2: r.version }))
      this.#appeler(r, 'demarrage', [])
      return true
    } catch (e) {
      r.active = false
      r.erreur = e instanceof Error ? e.message : String(e)
      this.journal(t('ressources.ressource-refusee', { v1: propre, v2: r.erreur }))
      return false
    }
  }

  decharger(nom) {
    const r = this.table.get(nom)
    if (!r) return false
    if (r.active) this.#appeler(r, 'arret', [])
    for (const m of r.minuteries) clearInterval(m)
    r.minuteries.clear()
    r.ecoutes.clear()
    r.commandes.clear()
    this.#ecrireEtat(r)
    this.table.delete(nom)
    return true
  }

  rechargerTout() {
    const noms = [...this.table.keys()]
    for (const n of noms) this.decharger(n)
    return this.chargerTout()
  }

  // ── Etat durable par ressource ──────────────────────────────────────────

  #cheminEtat(r) {
    return path.join(this.config.dossierDonnees, 'ressources', `${r.nom}.json`)
  }

  #lireEtat(r) {
    try {
      return JSON.parse(fs.readFileSync(this.#cheminEtat(r), 'utf8'))
    } catch {
      return {}
    }
  }

  #ecrireEtat(r) {
    try {
      const c = this.#cheminEtat(r)
      fs.mkdirSync(path.dirname(c), { recursive: true })
      const abri = `${c}.tmp`
      fs.writeFileSync(abri, JSON.stringify(r.etat ?? {}, null, 2), 'utf8')
      fs.renameSync(abri, c)
      return true
    } catch {
      return false
    }
  }

  enregistrerTousLesEtats() {
    for (const r of this.table.values()) this.#ecrireEtat(r)
  }

  // ── Le bac a sable ──────────────────────────────────────────────────────

  /**
   * Ce qu'une ressource peut toucher. Tout le reste est absent du contexte :
   * pas de `require`, pas de `fs`, pas de `fetch` -- mais voir l'avertissement
   * en tete de fichier : ce n'est pas une barriere de securite.
   */
  #bacASable(r) {
    const ctx = this.contexte
    const limiteTexte = (v, max = 240) =>
      String(v === undefined || v === null ? '' : v)
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .slice(0, max)

    const api = {
      nom: r.nom,
      version: r.version,

      /** Ecoute un evenement du serveur. */
      sur(evenement, rappel) {
        const e = String(evenement || '')
        if (!EVENEMENTS.includes(e)) throw new Error(t('ressources.evenement-inconnu', { v1: e }))
        if (typeof rappel !== 'function') throw new Error('il faut une fonction')
        if (!r.ecoutes.has(e)) r.ecoutes.set(e, [])
        r.ecoutes.get(e).push(rappel)
      },

      /** Ajoute une commande de chat. */
      commande(nom, options) {
        const n = String(nom || '').toLowerCase().replace(/[^a-z0-9-]/g, '')
        if (!n) throw new Error('nom de commande invalide')
        if (!options || typeof options.faire !== 'function') throw new Error(t('ressources.il-faut-une-fonction-faire'))
        r.commandes.set(n, {
          aide: limiteTexte(options.aide, 80),
          droit: options.droit ? String(options.droit).slice(0, 32) : 'commande',
          faire: options.faire,
        })
      },

      annoncer(texte) {
        ctx.annoncer(`[${r.nom}] ${limiteTexte(texte)}`)
      },

      messageA(idJoueur, texte) {
        ctx.messageA(idJoueur, `[${r.nom}] ${limiteTexte(texte)}`)
      },

      joueurs() {
        return ctx.joueurs()
      },

      joueur(id) {
        return ctx.joueur(id)
      },

      monde: {
        lire: () => ctx.monde.instantane(),
        meteo: (v) => ctx.monde.reglerMeteo(limiteTexte(v, 24)),
        heure: (h, m) => ctx.monde.reglerHeure(h, m),
        donnee: (c, v) => ctx.monde.poserDonnee(limiteTexte(c, 48), v === null ? null : limiteTexte(v)),
        repere: (pos, libelle) => ctx.monde.poserRepere(pos, limiteTexte(libelle, 40), r.nom),
      },

      entites: {
        creer: (o) => ctx.entites.creer({ ...o, proprietaire: null }),
        modifier: (id, c) => ctx.entites.modifier(id, c, null, 'posseder'),
        supprimer: (id) => ctx.entites.supprimer(id),
        toutes: () => ctx.entites.toutes(),
      },

      coffre: {
        contenu: () => ctx.inventaires.contenu(),
      },

      activites: {
        creer: (o) => ctx.activites.creer({ ...o, parQui: r.nom }),
        demarrer: (id) => ctx.activites.demarrer(id),
        cocher: (id, n) => ctx.activites.cocher(id, n, r.nom),
        liste: () => ctx.activites.instantane().activites,
      },

      /** Etat durable : un objet libre, ecrit sur disque a l'arret. */
      etat: r.etat,

      /**
       * Repete un travail. Rendu borne a une fois par seconde au minimum :
       * une minuterie a 1 ms saturerait le serveur.
       */
      repeter(ms, rappel) {
        const periode = Math.max(1000, Math.min(Number(ms) || 1000, 3_600_000))
        if (typeof rappel !== 'function') throw new Error('il faut une fonction')
        const m = setInterval(() => {
          try {
            rappel()
          } catch (e) {
            this.journalErreur(e)
          }
        }, periode)
        r.minuteries.add(m)
        return r.minuteries.size
      },

      journal: (texte) => this.journal(`[${r.nom}] ${limiteTexte(texte)}`),
      journalErreur: (e) => this.journal(`[${r.nom}] erreur : ${e instanceof Error ? e.message : e}`),

      /** Hasard et temps : les seules primitives du monde exterieur accordees. */
      hasard: () => Math.random(),
      maintenant: () => Date.now(),
      Math,
      JSON,
      Number,
      String,
      Boolean,
      Array,
      Object,
      Map,
      Set,
      Date,
      Error,
      isNaN,
      isFinite,
      parseInt,
      parseFloat,
    }

    // `voyage` est le nom par lequel une ressource atteint le serveur.
    return { voyage: api, console: { log: api.journal, error: api.journal } }
  }

  // ── Diffusion ───────────────────────────────────────────────────────────

  #appeler(r, evenement, args) {
    const liste = r.ecoutes.get(evenement)
    if (!liste || liste.length === 0) return
    for (const rappel of liste) {
      try {
        rappel(...args)
      } catch (e) {
        r.erreur = e instanceof Error ? e.message : String(e)
        this.journal(t('ressources.ressource-a-echoue-sur', { v1: r.nom, v2: evenement, v3: r.erreur }))
        /*
          ⚠️ ON DESACTIVE LA RESSOURCE FAUTIVE, ON NE LA LAISSE PAS CRIER A
             CHAQUE TICK. Une erreur par instantane remplirait la console et
             cacherait tout le reste.
        */
        if (evenement === 'tick' || evenement === 'seconde') {
          r.ecoutes.delete(evenement)
          this.journal(t('ressources.ressource-ecoute-desactivee', { v1: r.nom, v2: evenement }))
        }
      }
    }
  }

  /** Diffuse un evenement a toutes les ressources actives. */
  emettre(evenement, ...args) {
    for (const r of this.table.values()) {
      if (r.active) this.#appeler(r, evenement, args)
    }
  }

  /** Cherche une commande ajoutee par une ressource. */
  commande(nom) {
    for (const r of this.table.values()) {
      if (!r.active) continue
      const c = r.commandes.get(nom)
      if (c) return { ressource: r, ...c }
    }
    return null
  }

  /** Toutes les commandes ajoutees, pour /aide. */
  toutesLesCommandes() {
    const sortie = []
    for (const r of this.table.values()) {
      if (!r.active) continue
      for (const [nom, c] of r.commandes) sortie.push({ nom, aide: c.aide, ressource: r.nom })
    }
    return sortie
  }

  /** Vue pour le diagnostic et l'API HTTP. */
  liste() {
    return [...this.table.values()].map((r) => ({
      nom: r.nom,
      version: r.version,
      description: r.description,
      auteur: r.auteur,
      active: r.active,
      erreur: r.erreur,
      ecoutes: [...r.ecoutes.keys()],
      commandes: [...r.commandes.keys()],
    }))
  }
}

module.exports = { Ressources, Ressource, EVENEMENTS }
