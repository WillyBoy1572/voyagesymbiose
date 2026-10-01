'use strict'

const crypto = require('node:crypto')
const { T, langueValide } = require('./langues')
const { encoder } = require('./protocole')
const { Qualite } = require('./reseau')
const journal = require('./journal')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LA SESSION — qui est la, ou, et depuis quand
 * ═══════════════════════════════════════════════════════════════════════════
 *  Le serveur fait autorite. Un client annonce SA position ; il ne decide de
 *  rien d'autre. Toute affirmation sur le monde ou sur un autre joueur est
 *  ignoree.
 *
 *  ⚠️ LE JETON DE SESSION N'EST PAS UNE COQUETTERIE. En UDP, l'adresse
 *     source se falsifie en une ligne : sans jeton, n'importe qui pourrait
 *     deplacer le personnage d'un autre ou parler en son nom. Chaque paquet
 *     apres l'arrivee doit le porter.
 *
 *  ⚠️ LE PREMIER ARRIVE EST L'HOTE. Dans une partie entre amis il n'y a pas
 *     d'administrateur a declarer : celui qui ouvre la partie la dirige, et
 *     si il s'en va le plus ancien present reprend la main.
 *
 *  ⚠️ L'HOTE EST AUSSI L'AUTORITE SUR LES CREATURES. Elles ne vivent que dans
 *     SON jeu ; quand il part, le nouvel hote repart de ses propres creatures
 *     et le registre se vide. Sans ca, on afficherait des requins immobiles
 *     pour toujours.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Plafond de paquets par seconde et par joueur, avant qu'on cesse de l'ecouter. */
const PAQUETS_PAR_SECONDE = 160

/** Combien de temps on garde la place de quelqu'un qui vient de partir. */
const REPRISE_MS = 10 * 60_000

/**
 * Au-dela de cette distance (en centimetres), on cesse d'envoyer le detail
 * d'un joueur : sa vitesse, son geste et son animation ne servent a rien si
 * personne ne peut le voir.
 *
 * ⚠️ SA POSITION PART QUAND MEME, TOUJOURS. Elle sert au radar, aux distances
 *    et aux noms ; et surtout, un joueur absent de l'instantane serait compris
 *    comme « parti » par le mod, qui detruirait son pion.
 */
const DETAIL_JUSQUA = 15000

class Joueur {
  constructor({ id, nom, adresse, port, empreinte = null, spectateur = false, capacites = [], langue = 'fr' }) {
    this.id = id
    this.nom = nom
    this.adresse = adresse
    this.port = port
    this.jeton = crypto.randomBytes(16).toString('hex')
    /** Jeton remis au depart : il permet de reprendre sa place et son etat. */
    this.jetonReprise = crypto.randomBytes(12).toString('hex')
    /** Empreinte d'identite verifiee, ou `null` pour un anonyme. */
    this.empreinte = empreinte
    this.spectateur = spectateur === true
    this.capacites = new Set(capacites)
    /** La langue de SON lanceur. Le serveur lui parle dedans, pas dans la sienne. */
    this.langue = langueValide(langue)
    this.pos = { x: 0, y: 0, z: 0 }
    this.rot = { x: 0, y: 0, z: 0 }
    /* Ce qui fait marcher les jambes chez les autres : leur pion lit la vitesse. */
    this.vit = { x: 0, y: 0, z: 0 }
    this.anim = null
    this.geste = null
    this.gesteJusqua = 0
    /** `null` tant que le mod n'a pas su lire les points de vie. Jamais zero par defaut. */
    this.vie = null
    this.posture = null
    this.seq = -1
    this.arriveLe = Date.now()
    this.vuLe = Date.now()
    this.ping = 0
    /** Ecart entre l'horloge du client et la notre, en millisecondes. */
    this.decalage = null
    this.hote = false
    /** Compteur du plafond de paquets, remis a zero chaque seconde. */
    this.paquets = 0
    this.fenetre = Date.now()
    /** Ce que le mod a reussi a faire dans le jeu. Sert au diagnostic. */
    this.faits = {}
    /** Gigue, perte, aller-retour : ce que le joueur subit vraiment. */
    this.qualite = new Qualite()
  }

  /** Ce que les autres joueurs ont le droit de savoir. */
  publique(detail = true) {
    const base = {
      id: this.id,
      nom: this.nom,
      pos: this.pos,
      rot: this.rot,
      hote: this.hote,
      ping: this.ping,
    }
    if (this.spectateur) base.spectateur = true
    if (!detail) return base
    return {
      ...base,
      vit: this.vit,
      anim: this.anim,
      geste: this.geste && Date.now() < this.gesteJusqua ? this.geste : null,
      vie: this.vie,
      posture: this.posture,
    }
  }

  /**
   * Ce client sait-il quoi faire de ce genre de message ?
   *
   * ⚠️ UN CLIENT QUI N'ANNONCE RIEN RECOIT TOUT. C'est le cas de tous les
   *    clients d'avant la negociation : les priver de creatures ou d'evenements
   *    parce qu'ils n'ont pas su le demander serait casser ce qui marchait.
   *    On ne filtre que ceux qui ont EXPLICITEMENT dit ce qu'ils savaient faire.
   */
  sait(quoi) {
    if (this.capacites.size === 0) return true
    return this.capacites.has(quoi)
  }

  /**
   * ⚠️ LE PLAFOND EST PAR JOUEUR, PAS GLOBAL. Un client bogue qui part en
   *    boucle ne doit pas faire taire les trois autres.
   */
  autorise() {
    const maintenant = Date.now()
    if (maintenant - this.fenetre >= 1000) {
      this.fenetre = maintenant
      this.paquets = 0
    }
    this.paquets++
    return this.paquets <= PAQUETS_PAR_SECONDE
  }
}

class Session {
  /**
   * Les modules facultatifs sont tous facultatifs pour de vrai : sans eux, la
   * session fonctionne comme en 0.6.3. C'est ce qui permet aux essais de
   * monter une session nue.
   */
  constructor(config, monde, envoyer, modules = {}) {
    this.config = config
    this.monde = monde
    this.entites = modules.entites ?? null
    this.identites = modules.identites ?? null
    this.permissions = modules.permissions ?? null
    this.moderation = modules.moderation ?? null
    this.equipes = modules.equipes ?? null
    this.activites = modules.activites ?? null
    this.inventaires = modules.inventaires ?? null
    this.pnj = modules.pnj ?? null
    this.evenements = modules.evenements ?? null
    this.temps = modules.temps ?? null
    this.mesures = modules.mesures ?? null
    this.ressources = modules.ressources ?? null
    this.sauvegardes = modules.sauvegardes ?? null

    /** `envoyer(tampon, port, adresse)` — injecte par le serveur UDP. */
    this.envoyer = envoyer
    this.joueurs = new Map()
    this.parJeton = new Map()
    this.prochainId = 1
    this.tick = 0
    this.demarreLe = Date.now()
    /** Derniere revision du monde envoyee : evite de renvoyer le monde a chaque tick. */
    this.revisionEnvoyee = -1
    this.revisionEquipes = -1
    this.revisionActivites = -1
    this.revisionCoffre = -1
    /** jetonReprise -> etat garde pour celui qui revient. */
    this.reprises = new Map()
  }

  get nombre() {
    return this.joueurs.size
  }

  /** Les joueurs qui occupent une place, spectateurs exclus. */
  get nombreJouant() {
    let n = 0
    for (const j of this.joueurs.values()) if (!j.spectateur) n++
    return n
  }

  parAdresse(adresse, port) {
    for (const j of this.joueurs.values()) {
      if (j.adresse === adresse && j.port === port) return j
    }
    return null
  }

  parNom(nom) {
    const c = String(nom || '').toLowerCase()
    for (const j of this.joueurs.values()) {
      if (j.nom.toLowerCase() === c) return j
    }
    return null
  }

  parJetonValide(jeton, adresse, port) {
    if (!jeton) return null
    const j = this.parJeton.get(jeton)
    if (!j) return null
    /*
      ⚠️ ON VERIFIE AUSSI L'ADRESSE. Un jeton vole (journal partage, capture
         d'ecran) ne doit pas suffire depuis une autre machine. Le port peut
         changer au fil d'un NAT : on suit ce changement, mais pas l'adresse.
    */
    if (j.adresse !== adresse) return null
    if (j.port !== port) j.port = port
    return j
  }

  /** Le role effectif d'un joueur, calcule a l'instant. */
  role(joueur) {
    return this.permissions ? this.permissions.role(joueur) : joueur.hote ? 'hote' : 'joueur'
  }

  peut(joueur, permission) {
    return this.permissions ? this.permissions.peut(joueur, permission) : true
  }

  // ── Arrivee et depart ───────────────────────────────────────────────────

  accueillir(message, adresse, port) {
    /*
      ⚠️ ON ACCEPTE UNE PLAGE DE PROTOCOLES, PAS UN SEUL NUMERO. Exiger
         l'egalite rejetterait tous les joueurs a chaque mise a jour du
         serveur, y compris ceux qui n'ont pas encore relance leur lanceur.
    */
    const minimum = this.config.protocoleMinimum ?? this.config.protocole
    if (message.protocole < minimum || message.protocole > this.config.protocole) {
      return { refus: 'version_incompatible' }
    }

    if (this.config.motDePasse) {
      const attendu = Buffer.from(this.config.motDePasse)
      const donne = Buffer.from(message.motDePasse ?? '')
      // Comparaison a temps constant : sinon le temps de reponse trahit le mot de passe.
      const bon = attendu.length === donne.length && crypto.timingSafeEqual(attendu, donne)
      if (!bon) return { refus: 'mot_de_passe' }
    }

    // ── Identite ──────────────────────────────────────────────────────────

    let empreinte = null
    if (this.identites) {
      const preuve = this.identites.verifier({
        cle: message.cle,
        nom: message.nom,
        ts: message.ts,
        sig: message.sig,
      })
      if (preuve && preuve.refus) return { refus: `identite_${preuve.refus}` }
      if (preuve) empreinte = preuve.empreinte
      else if (this.config.identiteObligatoire) return { refus: 'identite_requise' }
    }

    // ── Bannissement ──────────────────────────────────────────────────────

    if (this.moderation) {
      const banni = this.moderation.banni(empreinte, adresse)
      if (banni) {
        return {
          refus: 'banni',
          detail: banni.raison || null,
          jusqua: banni.jusqua || 0,
        }
      }
    }

    /*
      ⚠️ UN SPECTATEUR N'OCCUPE PAS UNE PLACE DE JOUEUR, mais il occupe quand
         meme une place dans la session : sans plafond, un serveur a 4 places
         pourrait porter cinquante spectateurs et saturer la bande passante.
    */
    const spectateur = message.spectateur === true
    if (!spectateur && this.nombreJouant >= this.config.maxJoueurs) return { refus: 'complet' }
    if (this.joueurs.size >= this.config.maxJoueurs * 2) return { refus: 'complet' }

    // Reconnexion depuis la meme adresse et le meme port : on remplace.
    const ancien = this.parAdresse(adresse, port)
    if (ancien) this.retirer(ancien, 'reconnexion')

    /*
      ⚠️ UNE IDENTITE NE PEUT PAS ETRE A DEUX ENDROITS. Sans ca, le meme joueur
         pouvait ouvrir deux sessions : deux pions a son nom, deux positions
         ecrites a tour de role dans le meme profil, et un bannissement qui ne
         coupait qu'une des deux. La NOUVELLE connexion gagne — c'est le cas du
         joueur qui a plante et qui revient, et c'est lui qui a la main.
    */
    if (empreinte) {
      for (const autre of [...this.joueurs.values()]) {
        if (autre.empreinte === empreinte) {
          journal.avis(T(this.config.langue, 'session.remplace', { v1: autre.nom }))
          this.envoyerA(autre, {
            t: 'expulse',
            // La raison part dans SA langue : c'est lui qui la lit, pas nous.
            raison: T(autre.langue, 'session.expulse-remplace'),
          })
          this.retirer(autre, T(this.config.langue, 'session.reprise-ailleurs'))
        }
      }
    }

    const nom = this.#nomLibre(message.nom)
    const joueur = new Joueur({
      id: this.prochainId++,
      nom,
      adresse,
      port,
      empreinte,
      spectateur,
      capacites: message.capacites,
      langue: message.langue,
    })
    joueur.hote = this.nombreJouant === 0 && !spectateur

    this.joueurs.set(joueur.id, joueur)
    this.parJeton.set(joueur.jeton, joueur)

    if (this.identites && empreinte) this.identites.arrivee(empreinte, nom)

    /*
      ⚠️ ON REND SA DERNIERE POSITION AU JOUEUR QUI REVIENT. Sans ca, les
         autres le voient reapparaitre a l'origine du monde le temps que son
         jeu envoie sa vraie position — un saut visible a chaque reconnexion.
         Le jeu, lui, reste maitre : la premiere position qu'il envoie
         remplace celle-ci.
    */
    let repris = null
    if (message.reprise) repris = this.#reprendre(joueur, message.reprise)
    if (!repris) {
      const connu = this.sauvegardes ? this.sauvegardes.positionDe(nom) : null
      if (connu) {
        joueur.pos = connu.pos
        joueur.rot = connu.rot
        joueur.reprise = connu.vuLe
      }
    }

    if (this.pnj && joueur.hote) this.pnj.changerAutorite(joueur.id)

    journal.info(
      `${nom}${spectateur ? ' (spectateur)' : ''} rejoint la partie (${adresse})` +
        `${empreinte ? ` [${empreinte}]` : ''} — ${this.nombreJouant}/${this.config.maxJoueurs}`,
    )
    this.diffuser({ t: 'arrivee', joueur: joueur.publique() }, joueur.id)
    if (this.ressources) this.ressources.emettre('arrivee', this.vuePourRessource(joueur))

    return { joueur, repris: Boolean(repris) }
  }

  /**
   * ⚠️ DEUX JOUEURS NE PEUVENT PAS PORTER LE MEME NOM. Sinon le chat devient
   *    illisible et les commandes qui visent un nom frappent au hasard.
   */
  #nomLibre(souhaite) {
    const pris = new Set([...this.joueurs.values()].map((j) => j.nom.toLowerCase()))
    if (!pris.has(souhaite.toLowerCase())) return souhaite
    for (let i = 2; i < 100; i++) {
      const essai = `${souhaite} (${i})`
      if (!pris.has(essai.toLowerCase())) return essai
    }
    return `${souhaite} ${Date.now() % 1000}`
  }

  /**
   * Rend sa place a quelqu'un qui revient avec son jeton de reprise.
   *
   * ⚠️ LE JETON SE CONSOMME. Sans ca, deux clients pourraient reprendre la
   *    meme place avec le meme jeton, et chacun croirait etre le bon.
   *
   * ⚠️ ON NE REND LA PLACE QU'A LA MEME IDENTITE. Un jeton intercepte ne doit
   *    pas donner acces a l'etat de quelqu'un d'autre. Pour un anonyme il n'y
   *    a rien a comparer : on se contente du jeton, qui est deja un secret.
   */
  #reprendre(joueur, jetonReprise) {
    const garde = this.reprises.get(jetonReprise)
    if (!garde) return null
    if (Date.now() - garde.quand > REPRISE_MS) {
      this.reprises.delete(jetonReprise)
      return null
    }
    if (garde.empreinte && garde.empreinte !== joueur.empreinte) return null

    this.reprises.delete(jetonReprise)
    joueur.pos = garde.pos
    joueur.rot = garde.rot
    joueur.vie = garde.vie
    if (this.equipes && garde.idEquipe) this.equipes.mettre(joueur.id, garde.idEquipe)
    journal.info(`${joueur.nom} reprend sa place (absent ${Math.round((Date.now() - garde.quand) / 1000)} s).`)
    return garde
  }

  retirer(joueur, raison = 'depart') {
    if (!this.joueurs.has(joueur.id)) return
    /*
      ⚠️ ON ECRIT AU DEPART, PAS SEULEMENT SUR LA MINUTERIE. C'est l'instant
         ou la position devient definitive, et un depart est rare : aucun
         cout pour le disque. S'en remettre aux quinze secondes rendait la
         durabilite dependante d'un arret propre — or `SIGTERM` ne declenche
         RIEN sous Windows, et une machine qui tombe n'annonce rien nulle part.
    */
    if (this.sauvegardes) {
      this.sauvegardes.retenirPosition(joueur.nom, joueur.pos, joueur.rot)
      this.sauvegardes.enregistrerSiBesoin()
    }
    if (this.identites && joueur.empreinte) {
      this.identites.depart(joueur.empreinte, Date.now() - joueur.arriveLe)
      this.identites.enregistrerSiBesoin()
    }
    /*
      ⚠️ CE QUI LUI APPARTENAIT REDEVIENT LIBRE. Un objet dont le proprietaire
         se deconnecte resterait verrouille pour toujours : plus personne ne
         pourrait y toucher, et rien a l'ecran ne dirait pourquoi.
    */
    if (this.entites) {
      const liberees = this.entites.libererCeuxDe(joueur.id)
      if (liberees) journal.info(`${liberees} entite(s) liberee(s) par le depart de ${joueur.nom}.`)
    }

    // On garde son etat un moment : il peut revenir d'un plantage.
    this.reprises.set(joueur.jetonReprise, {
      nom: joueur.nom,
      empreinte: joueur.empreinte,
      pos: joueur.pos,
      rot: joueur.rot,
      vie: joueur.vie,
      idEquipe: this.equipes ? (this.equipes.equipeDe(joueur.id)?.id ?? null) : null,
      quand: Date.now(),
    })

    if (this.equipes) this.equipes.oublier(joueur.id)
    if (this.inventaires) this.inventaires.oublier(joueur.id)
    if (this.evenements) this.evenements.oublier(joueur.id)

    this.joueurs.delete(joueur.id)
    this.parJeton.delete(joueur.jeton)
    journal.info(`${joueur.nom} quitte la partie (${raison}) — ${this.nombreJouant}/${this.config.maxJoueurs}`)
    this.diffuser({ t: 'depart', id: joueur.id, nom: joueur.nom, raison })
    if (this.ressources) this.ressources.emettre('depart', this.vuePourRessource(joueur), raison)

    // L'hote s'en va : le plus ancien present reprend la main.
    if (joueur.hote) {
      const candidats = [...this.joueurs.values()].filter((j) => !j.spectateur)
      if (candidats.length > 0) {
        const suivant = candidats.sort((a, b) => a.arriveLe - b.arriveLe)[0]
        suivant.hote = true
        journal.info(`${suivant.nom} devient l'hote.`)
        this.messageA(suivant, 'session.te-voila-hote')
        this.diffuser({ t: 'hote', id: suivant.id, nom: suivant.nom })
        /*
          ⚠️ LE NOUVEL HOTE REMET LES CREATURES A ZERO. Elles vivaient dans le
             jeu de l'ancien ; les garder afficherait des requins immobiles.
        */
        if (this.pnj) this.pnj.changerAutorite(suivant.id)
      } else if (this.pnj) {
        this.pnj.changerAutorite(null)
      }
    }
  }

  /** Coupe les joueurs muets depuis trop longtemps. */
  balayer() {
    const limite = Date.now() - this.config.delaiMs
    for (const j of [...this.joueurs.values()]) {
      if (j.vuLe < limite) this.retirer(j, 'silence')
    }
    /*
      ⚠️ LES REPRISES EXPIRENT. Les garder pour toujours remplirait la memoire
         et laisserait des jetons valables indefiniment.
    */
    const limiteReprise = Date.now() - REPRISE_MS
    for (const [cle, g] of this.reprises) {
      if (g.quand < limiteReprise) this.reprises.delete(cle)
    }
  }

  // ── Envois ──────────────────────────────────────────────────────────────

  envoyerA(joueur, objet) {
    const tampon = encoder(objet)
    if (this.mesures) this.mesures.envoye(tampon.length)
    this.envoyer(tampon, joueur.port, joueur.adresse)
    return tampon.length
  }

  diffuser(objet, saufId = null) {
    const tampon = encoder(objet)
    for (const j of this.joueurs.values()) {
      if (j.id !== saufId) {
        if (this.mesures) this.mesures.envoye(tampon.length)
        this.envoyer(tampon, j.port, j.adresse)
      }
    }
    return tampon.length
  }

  /** Envoie a ceux que l'evenement concerne, selon sa portee. */
  diffuserAutour(evenement) {
    if (!this.evenements) return 0
    let combien = 0
    for (const j of this.joueurs.values()) {
      if (!j.sait('evenement')) continue
      if (!this.evenements.concerne(evenement, j)) continue
      this.envoyerA(j, evenement)
      combien++
    }
    return combien
  }

  /**
   * Un message systeme a une personne, dans SA langue.
   *
   * ⚠️ DEUX FORMES, ET LA DIFFERENCE COMPTE. Avec une cle, on traduit : c'est
   *    nous qui parlons. Avec `brut`, on envoie tel quel : c'est quelqu'un
   *    d'autre qui parle -- un message de chat, un pseudo, une raison de
   *    bannissement tapee a la main. Traduire la parole de quelqu'un serait la
   *    reecrire, et on ne le fait jamais.
   */
  messageA(joueur, cle, valeurs = null) {
    this.envoyerA(joueur, { t: 'systeme', texte: T(joueur.langue, cle, valeurs) })
  }

  messageBrutA(joueur, texte) {
    this.envoyerA(joueur, { t: 'systeme', texte })
  }

  /**
   * Le meme message a tout le monde, chacun dans sa langue.
   *
   * ⚠️ ON NE DIFFUSE PAS UN TAMPON UNIQUE. Trois joueurs peuvent lire la meme
   *    partie en trois langues : il faut encoder une fois par langue presente,
   *    pas une fois pour tous. C'est le prix, et il est petit -- trois encodages
   *    au lieu d'un, sur un message qui part rarement.
   */
  messageATous(cle, valeurs = null) {
    for (const j of this.joueurs.values()) {
      this.envoyerA(j, { t: 'systeme', texte: T(j.langue, cle, valeurs) })
    }
  }

  /** Le meme, tel quel : la parole de quelqu'un, pas la notre. */
  messageBrutATous(texte) {
    this.diffuser({ t: 'systeme', texte })
  }

  /** Meme chose, sous un nom que le reste du serveur peut appeler sans ambiguite. */
  annoncer(cle, valeurs = null) {
    this.messageATous(cle, valeurs)
  }

  /** Ce qu'une ressource voit d'un joueur : jamais son adresse ni son jeton. */
  vuePourRessource(joueur) {
    return {
      id: joueur.id,
      nom: joueur.nom,
      pos: { ...joueur.pos },
      hote: joueur.hote,
      spectateur: joueur.spectateur,
      role: this.role(joueur),
      empreinte: joueur.empreinte,
      ping: joueur.ping,
      equipe: this.equipes ? (this.equipes.equipeDe(joueur.id)?.nom ?? null) : null,
    }
  }

  /**
   * Un instantane par tick.
   *
   * ⚠️ LE MONDE N'EST JOINT QUE S'IL A CHANGE. L'envoyer a chaque tick
   *    multiplierait la taille du paquet par dix pour rien : les reperes et
   *    la meteo bougent une fois par heure, pas vingt fois par seconde. Meme
   *    regle pour les equipes, les activites et le coffre.
   *
   * ⚠️ UN JOUEUR N'EST JAMAIS ABSENT DE L'INSTANTANE. On reduit son DETAIL
   *    quand il est loin — vitesse, geste, animation — mais sa position part
   *    toujours : le mod comprendrait une absence comme un depart et
   *    detruirait son pion.
   */
  instantane() {
    this.tick++
    if (this.joueurs.size === 0) return 0

    const debut = process.hrtime.bigint()
    const tous = [...this.joueurs.values()]

    const commun = {
      t: 'instantane',
      tick: this.tick,
    }

    if (this.monde.revision !== this.revisionEnvoyee) {
      commun.monde = this.monde.instantane()
      this.revisionEnvoyee = this.monde.revision
    }
    if (this.equipes && this.equipes.revision !== this.revisionEquipes) {
      commun.equipes = this.equipes.instantane()
      this.revisionEquipes = this.equipes.revision
    }
    if (this.activites && this.activites.revision !== this.revisionActivites) {
      commun.activites = this.activites.instantane()
      this.revisionActivites = this.activites.revision
    }
    if (this.inventaires && this.inventaires.revision !== this.revisionCoffre) {
      commun.coffre = this.inventaires.instantane()
      this.revisionCoffre = this.inventaires.revision
    }
    if (this.temps && this.tick % 100 === 0) {
      // L'heure part cinq fois par minute : assez pour corriger, assez peu pour ne rien couter.
      commun.temps = this.temps.instantane()
    }

    /*
      ⚠️ LE CHEMIN PAS CHER EXISTE ENCORE. Sans entites, sans creatures et sans
         joueur lointain, l'instantane est le meme pour tout le monde : une
         seule serialisation, un seul tampon. C'est le cas d'une partie a deux
         qui vient de commencer, et il ne faut pas le payer au prix d'une
         partie a seize.
    */
    const detailPourTous = tous.length <= 2
    const sansEntites = !this.entites || this.entites.nombre === 0
    const sansPnj = !this.pnj || this.pnj.nombre === 0

    if (detailPourTous && sansEntites && sansPnj) {
      const taille = this.diffuser({ ...commun, joueurs: tous.map((j) => j.publique(true)) })
      this.#mesurerTick(debut, taille)
      return taille
    }

    let taille = 0
    for (const j of tous) {
      const paquet = { ...commun, joueurs: this.#joueursPour(j, tous) }
      if (!sansEntites) {
        const proches = this.entites.pour(j, this.tick)
        if (proches) paquet.entites = proches
      }
      if (!sansPnj && j.sait('pnj')) {
        const creatures = this.pnj.pour(j, this.tick)
        if (creatures) paquet.pnj = creatures
      }
      taille = this.envoyerA(j, paquet)
    }
    this.#mesurerTick(debut, taille)
    return taille
  }

  #joueursPour(destinataire, tous) {
    const ici = destinataire.pos || { x: 0, y: 0, z: 0 }
    const sortie = []
    for (const j of tous) {
      if (j.id === destinataire.id) {
        sortie.push(j.publique(true))
        continue
      }
      const dx = (j.pos.x || 0) - (ici.x || 0)
      const dy = (j.pos.y || 0) - (ici.y || 0)
      const dz = (j.pos.z || 0) - (ici.z || 0)
      const loin = dx * dx + dy * dy + dz * dz > DETAIL_JUSQUA * DETAIL_JUSQUA
      sortie.push(j.publique(!loin))
    }
    return sortie
  }

  #mesurerTick(debut, octets) {
    if (!this.mesures) return
    const ms = Number(process.hrtime.bigint() - debut) / 1e6
    this.mesures.tick(ms, octets)
  }

  etat() {
    return {
      nom: this.config.nom,
      version: this.config.version,
      protocole: this.config.protocole,
      protocoleMinimum: this.config.protocoleMinimum,
      joueurs: this.nombreJouant,
      spectateurs: this.joueurs.size - this.nombreJouant,
      maxJoueurs: this.config.maxJoueurs,
      motDePasse: Boolean(this.config.motDePasse),
      hz: this.config.hz,
      tick: this.tick,
      deboutDepuisS: Math.round((Date.now() - this.demarreLe) / 1000),
    }
  }
}

module.exports = { Session, Joueur, PAQUETS_PAR_SECONDE }
