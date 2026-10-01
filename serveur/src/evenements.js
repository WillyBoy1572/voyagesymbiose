'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EVENEMENTS — ce qui se produit une fois, et que les autres doivent voir
 * ═══════════════════════════════════════════════════════════════════════════
 *  Une porte qui s'ouvre, une machine qui demarre, une alarme, un coup de
 *  feu, un ping pose sur un mur, un geste de la main. Rien de tout ca n'a
 *  d'etat durable : c'est un instant, il part, il s'affiche, il est oublie.
 *
 *  ⚠️ ON NE TRANSPORTE AUCUN SON. Ce serait du contenu du jeu, et le diffuser
 *     serait le redistribuer. On transporte le FAIT : « une alarme a sonne
 *     ici ». Chaque jeu joue alors son propre son, celui qu'il a deja.
 *
 *  ⚠️ LA LISTE DES GENRES EST FERMEE. Un client ne doit pas pouvoir inventer
 *     un genre d'evenement : le mod d'en face ne saurait qu'en faire, et ce
 *     serait la porte ouverte a du texte arbitraire affiche chez les autres.
 *
 *  ⚠️ UN EVENEMENT PART A CEUX QUI SONT A PORTEE, PAS A TOUT LE MONDE. Une
 *     porte ouverte a huit cents metres n'interesse personne — et l'envoyer
 *     quand meme ferait clignoter un message chez tous les joueurs a chaque
 *     fois que l'un d'eux touche un interrupteur.
 *
 *  ⚠️ IL Y A UN PLAFOND PAR JOUEUR ET PAR SECONDE. Une machine qui se met a
 *     clignoter enverrait vingt evenements par seconde, et le chat de tous les
 *     autres deviendrait illisible.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Les genres acceptes, et la distance au-dela de laquelle on n'envoie plus
 * (en centimetres, l'unite d'Unreal).
 */
const GENRES = {
  /** Interactions sur le decor. */
  porte: { portee: 6000, texte: null },
  interrupteur: { portee: 6000, texte: null },
  machine: { portee: 10000, texte: null },
  conteneur: { portee: 6000, texte: null },
  /** Evenements forts : audibles de loin. */
  alarme: { portee: 40000, texte: 'Une alarme sonne.' },
  explosion: { portee: 40000, texte: null },
  tir: { portee: 20000, texte: null },
  degat: { portee: 8000, texte: null },
  mort: { portee: 1_000_000, texte: null },
  /** Communication entre joueurs. */
  ping: { portee: 1_000_000, texte: null },
  geste: { portee: 12000, texte: null },
  /** Construction. */
  pose: { portee: 10000, texte: null },
  retrait: { portee: 10000, texte: null },
}

/** Les gestes qu'un joueur peut faire. Fermee, comme le reste. */
const GESTES = ['salut', 'pointer', 'oui', 'non', 'stop', 'venez', 'assis', 'applaudir']

/** Plafond par joueur. Au-dela, on jette en silence. */
const PAR_SECONDE = 8

/** Combien d'evenements on garde pour le diagnostic. */
const HISTORIQUE = 60

function distance2(a, b) {
  const dx = (a.x || 0) - (b.x || 0)
  const dy = (a.y || 0) - (b.y || 0)
  const dz = (a.z || 0) - (b.z || 0)
  return dx * dx + dy * dy + dz * dz
}

class Evenements {
  constructor(journal) {
    this.journal = journal || (() => {})
    /** idJoueur -> { compte, fenetre } */
    this.debits = new Map()
    this.historique = []
    this.total = 0
  }

  /** Le genre existe-t-il ? */
  static connu(genre) {
    return Object.prototype.hasOwnProperty.call(GENRES, genre)
  }

  /**
   * Un joueur a-t-il encore le droit d'envoyer ?
   *
   * ⚠️ LE PLAFOND EST PAR JOUEUR. Un mod qui part en boucle ne doit pas faire
   *    taire les autres.
   */
  autorise(idJoueur, maintenant = Date.now()) {
    let d = this.debits.get(idJoueur)
    if (!d || maintenant - d.fenetre >= 1000) {
      d = { compte: 0, fenetre: maintenant }
      this.debits.set(idJoueur, d)
    }
    d.compte++
    return d.compte <= PAR_SECONDE
  }

  oublier(idJoueur) {
    this.debits.delete(idJoueur)
  }

  /**
   * Prepare un evenement a diffuser. Rend l'objet a envoyer, ou `null`.
   *
   * @param {object} joueur l'auteur
   * @param {{genre:string, pos?:object, cible?:string, valeur?:string|number}} brut
   */
  preparer(joueur, brut) {
    if (!brut || !Evenements.connu(brut.genre)) return null
    if (!this.autorise(joueur.id)) return null

    const genre = brut.genre
    const pos = brut.pos && Number.isFinite(brut.pos.x) ? brut.pos : joueur.pos

    if (genre === 'geste' && !GESTES.includes(String(brut.valeur || ''))) return null

    const e = {
      t: 'evenement',
      genre,
      de: joueur.nom,
      id: joueur.id,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      cible: brut.cible ? String(brut.cible).slice(0, 48) : null,
      valeur: brut.valeur === undefined ? null : brut.valeur,
      ts: Date.now(),
    }

    this.total++
    this.historique.push({ genre, de: e.de, quand: e.ts, cible: e.cible })
    if (this.historique.length > HISTORIQUE) this.historique = this.historique.slice(-HISTORIQUE)
    return e
  }

  /** Vrai si cet evenement doit atteindre ce joueur. */
  concerne(evenement, joueur) {
    if (joueur.id === evenement.id) return false
    const g = GENRES[evenement.genre]
    if (!g) return false
    const portee = g.portee
    if (portee >= 1_000_000) return true
    return distance2(joueur.pos || { x: 0, y: 0, z: 0 }, evenement.pos) <= portee * portee
  }

  /** Le texte a afficher, s'il y en a un pour ce genre. */
  static texte(evenement) {
    const g = GENRES[evenement.genre]
    if (!g) return null
    if (evenement.genre === 'geste') return `${evenement.de} fait « ${evenement.valeur} ».`
    if (evenement.genre === 'ping') {
      return evenement.valeur ? `${evenement.de} marque : ${evenement.valeur}` : `${evenement.de} marque un point.`
    }
    if (evenement.genre === 'mort') return `${evenement.de} est tombé.`
    return g.texte
  }

  recents(combien = 20) {
    return this.historique.slice(-combien).reverse()
  }
}

module.exports = { Evenements, GESTES }
