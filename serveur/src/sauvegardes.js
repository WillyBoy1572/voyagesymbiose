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
const crypto = require('node:crypto')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CE QUE LE SERVEUR GARDE SUR DISQUE
 * ═══════════════════════════════════════════════════════════════════════════
 *  Deux choses, et rien d'autre :
 *    LE MONDE     l'archive des sauvegardes publiee par l'hote, telle quelle.
 *    LES JOUEURS  la derniere position connue de chacun, par nom.
 *
 *  ⚠️ LE SERVEUR N'OUVRE JAMAIS L'ARCHIVE. Il la recoit, la pese, en prend
 *     l'empreinte et la rend. Decompresser du contenu envoye par un client
 *     sur la machine qui heberge, c'est offrir un chemin d'ecriture
 *     arbitraire ; c'est au LANCEUR de l'ouvrir, chez le joueur, apres
 *     verification. Un octet de l'archive n'est jamais interprete ici.
 *
 *  ⚠️ PUBLIER EXIGE UN MOT DE PASSE, ET SANS LUI C'EST REFUSE. Un serveur
 *     ou n'importe qui peut remplacer le monde de la partie n'est pas un
 *     serveur, c'est un accident qui attend. Pas de valeur par defaut.
 *
 *  ⚠️ ECRITURE A COTE PUIS RENOMMAGE. Une coupure de courant au milieu d'un
 *     televersement laisserait sinon une archive tronquee que tout le monde
 *     installerait.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Une archive de sauvegardes pese quelques Mo. Au-dela, on refuse. */
const TAILLE_MAX = 256 * 1024 * 1024
/** On ne garde pas l'historique de tous les mondes publies, juste le precedent. */
const GARDE = 1

class Sauvegardes {
  constructor(config, journal = () => {}) {
    this.dossier = config.dossierDonnees
    this.journal = journal
    this.motDePasse = config.motDePasseMonde

    fs.mkdirSync(this.dossier, { recursive: true })
    this.cheminArchive = path.join(this.dossier, 'monde.zip')
    this.cheminFiche = path.join(this.dossier, 'monde.json')
    this.cheminJoueurs = path.join(this.dossier, 'joueurs.json')
    this.cheminRdv = path.join(this.dossier, 'rendez-vous.json')

    /*
      ⚠️ LE MOT DE PASSE PEUT VENIR D'UN FICHIER. L'egg du panneau n'expose
         pas `MONDE_MOTDEPASSE` : sans ce repli, l'hebergement ne permet tout
         simplement pas de publier un monde. Un fichier depose dans le
         gestionnaire du panneau, lui, est a la portee de l'utilisateur.

      ⚠️ ON NE LE FABRIQUE PAS, ON NE LE DEVINE PAS. Absent, la publication
         reste fermee : c'est a celui qui heberge de choisir son mot de passe.
    */
    if (!this.motDePasse) {
      try {
        const brut = fs.readFileSync(path.join(this.dossier, 'motdepasse-monde.txt'), 'utf8')
        const propre = brut.split(/\r?\n/)[0].trim()
        if (propre) {
          this.motDePasse = propre
          this.journal(t('sauvegardes.mot-de-passe-du-monde'))
        }
      } catch {
        /* pas de fichier : publication fermee, et c'est tres bien */
      }
    }

    this.fiche = this.lireJson(this.cheminFiche, null)
    this.joueurs = this.lireJson(this.cheminJoueurs, {})
    this.rendezVous = this.lireJson(this.cheminRdv, null)

    // Une fiche sans archive ment : on la jette plutot que de promettre un monde absent.
    if (this.fiche && !fs.existsSync(this.cheminArchive)) {
      this.fiche = null
      this.journal(t('sauvegardes.fiche-de-monde-sans-archive'))
    }
  }

  lireJson(chemin, defaut) {
    try {
      return JSON.parse(fs.readFileSync(chemin, 'utf8'))
    } catch {
      return defaut
    }
  }

  ecrireJson(chemin, valeur) {
    const abri = `${chemin}.tmp`
    fs.writeFileSync(abri, JSON.stringify(valeur, null, 1), 'utf8')
    fs.renameSync(abri, chemin)
  }

  // ── Le monde ──────────────────────────────────────────────────────────────

  /** Ce qu'on accepte de dire du monde a n'importe qui. */
  infoMonde() {
    if (!this.fiche) return { present: false, publicationOuverte: Boolean(this.motDePasse) }
    return {
      present: true,
      publicationOuverte: Boolean(this.motDePasse),
      nom: this.fiche.nom,
      etiquette: this.fiche.etiquette,
      note: this.fiche.note,
      publiePar: this.fiche.publiePar,
      empreinte: this.fiche.empreinte,
      taille: this.fiche.taille,
      fichiers: this.fiche.fichiers,
      date: this.fiche.date,
    }
  }

  cheminDuMonde() {
    return this.fiche && fs.existsSync(this.cheminArchive) ? this.cheminArchive : null
  }

  /**
   * L'hote publie un monde.
   *
   * ⚠️ L'EMPREINTE EST CALCULEE ICI, PAS FOURNIE PAR LE CLIENT. Une empreinte
   *    qu'on accepte sur parole ne verifie rien du tout.
   */
  publierMonde({ octets, nom, etiquette, note, publiePar, fichiers }) {
    if (!Buffer.isBuffer(octets) || octets.length === 0) throw new Error('archive vide')
    if (octets.length > TAILLE_MAX) throw new Error('archive trop grosse')

    /*
      ⚠️ ON VERIFIE QUE C'EST UN ZIP. Les deux premiers octets « PK » ne
         prouvent pas grand-chose, mais ils arretent l'envoi accidentel d'un
         fichier de sauvegarde brut, qui ne s'installerait chez personne.
    */
    if (octets[0] !== 0x50 || octets[1] !== 0x4b) throw new Error(t('sauvegardes.ce-n-est-pas-une'))

    const empreinte = crypto.createHash('sha256').update(octets).digest('hex')

    // Le monde precedent est garde de cote : une publication rateee se defait.
    if (fs.existsSync(this.cheminArchive) && GARDE > 0) {
      try {
        fs.copyFileSync(this.cheminArchive, `${this.cheminArchive}.precedent`)
        if (this.fiche) this.ecrireJson(`${this.cheminFiche}.precedent`, this.fiche)
      } catch {
        /* pas de place, pas de filet : on continue quand meme */
      }
    }

    const abri = `${this.cheminArchive}.tmp`
    fs.writeFileSync(abri, octets)
    fs.renameSync(abri, this.cheminArchive)

    this.fiche = {
      nom: String(nom ?? 'Monde').slice(0, 60),
      etiquette: String(etiquette ?? '').slice(0, 60),
      note: String(note ?? '').slice(0, 280),
      publiePar: String(publiePar ?? t('sauvegardes.hote')).slice(0, 24),
      fichiers: Number.isFinite(fichiers) ? fichiers : null,
      empreinte,
      taille: octets.length,
      date: new Date().toISOString(),
    }
    this.ecrireJson(this.cheminFiche, this.fiche)

    this.journal(t('sauvegardes.monde-publie-par-ko', { v1: this.fiche.nom, v2: this.fiche.publiePar, v3: Math.round(octets.length / 1024) }))
    return this.infoMonde()
  }

  /** Revenir au monde d'avant, si on l'a encore. */
  revenirEnArriere() {
    const avant = `${this.cheminArchive}.precedent`
    const ficheAvant = this.lireJson(`${this.cheminFiche}.precedent`, null)
    if (!fs.existsSync(avant) || !ficheAvant) throw new Error(t('sauvegardes.aucun-monde-precedent'))

    fs.copyFileSync(avant, this.cheminArchive)
    this.fiche = ficheAvant
    this.ecrireJson(this.cheminFiche, this.fiche)
    this.journal(t('sauvegardes.retour-au-monde-precedent', { v1: this.fiche.nom }))
    return this.infoMonde()
  }

  /**
   * ⚠️ COMPARAISON A TEMPS CONSTANT. Comparer deux mots de passe avec `===`
   *    laisse fuir leur longueur commune par le temps de reponse ; sur un
   *    port public ca se mesure.
   */
  motDePasseValide(donne) {
    if (!this.motDePasse) return false
    const a = Buffer.from(String(donne ?? ''))
    const b = Buffer.from(this.motDePasse)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  }

  // ── Le point de rendez-vous ───────────────────────────────────────────────

  /**
   * Ou les joueurs se retrouvent.
   *
   * ⚠️ IL EXISTE PARCE QUE LE SERVEUR N'A PAS DE JOUEUR DE REFERENCE. Il est
   *    heberge : personne n'y joue, donc aucune position « de l'hote » ne
   *    peut servir de point d'arrivee. Sans ca, deux joueurs chargent
   *    chacun leur sauvegarde et se retrouvent a des kilometres, avec un
   *    lien qui marche parfaitement et personne en vue.
   *
   * ⚠️ IL N'EST JAMAIS APPLIQUE TOUT SEUL. Teleporter quelqu'un a son
   *    arrivee, c'est le sortir de sa partie sans lui demander — et si le
   *    point vient d'un AUTRE monde, c'est le jeter dans le vide. Le serveur
   *    le propose ; le joueur appuie sur une touche.
   */
  pointDeRendezVous() {
    return this.rendezVous
  }

  poserRendezVous(nom, pos, rot) {
    if (!pos || !Number.isFinite(pos.x)) throw new Error('position inconnue')
    this.rendezVous = {
      pos: { x: pos.x, y: pos.y, z: pos.z },
      rot: rot ?? { x: 0, y: 0, z: 0 },
      parQui: String(nom).slice(0, 24),
      le: new Date().toISOString(),
    }
    this.ecrireJson(this.cheminRdv, this.rendezVous)
    this.journal(t('sauvegardes.point-de-rendez-vous-pose', { v1: this.rendezVous.parQui }))
    return this.rendezVous
  }

  oublierRendezVous() {
    this.rendezVous = null
    try {
      fs.rmSync(this.cheminRdv, { force: true })
    } catch {
      /* rien a faire */
    }
  }

  // ── Les joueurs ───────────────────────────────────────────────────────────

  /**
   * Ou etait ce joueur la derniere fois.
   *
   * ⚠️ LA CLE EST LE NOM, FAUTE DE MIEUX. Le jeu ne nous donne aucune
   *    identite stable ; deux personnes qui choisissent le meme pseudo
   *    partagent donc leur position. C'est le prix d'un serveur prive sans
   *    comptes, et il vaut mieux le dire que le cacher.
   */
  positionDe(nom) {
    const e = this.joueurs[String(nom).toLowerCase()]
    return e ? { pos: e.pos, rot: e.rot, vuLe: e.vuLe } : null
  }

  retenirPosition(nom, pos, rot) {
    if (!pos || !Number.isFinite(pos.x)) return
    this.joueurs[String(nom).toLowerCase()] = {
      nom: String(nom).slice(0, 24),
      pos,
      rot: rot ?? { x: 0, y: 0, z: 0 },
      vuLe: new Date().toISOString(),
    }
    this.aEcrire = true
  }

  /**
   * ⚠️ ON N'ECRIT PAS A CHAQUE POSITION. Vingt fois par seconde et par
   *    joueur, le disque deviendrait le goulot du serveur. On regroupe.
   */
  enregistrerSiBesoin() {
    if (!this.aEcrire) return
    this.aEcrire = false
    try {
      this.ecrireJson(this.cheminJoueurs, this.joueurs)
    } catch (e) {
      this.journal(t('sauvegardes.impossible-d-ecrire-les-positions', { v1: e.message }))
    }
  }

  /** Combien de joueurs connus, pour l'affichage. */
  nombreConnus() {
    return Object.keys(this.joueurs).length
  }
}

module.exports = { Sauvegardes, TAILLE_MAX }
