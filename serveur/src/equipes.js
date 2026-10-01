'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  EQUIPES — se repartir, et dire quand on est prêt
 * ═══════════════════════════════════════════════════════════════════════════
 *  Le jeu est cooperatif : les equipes ne servent pas a s'affronter, elles
 *  servent a savoir a qui on parle et a qui appartient un repere.
 *
 *  ⚠️ LES EQUIPES NE SURVIVENT PAS AU REDEMARRAGE, ET C'EST VOULU. Elles
 *     s'improvisent le temps d'une soiree ; les ecrire sur le disque
 *     obligerait a les nettoyer a la main des mois plus tard.
 *
 *  ⚠️ UN JOUEUR N'EST QUE DANS UNE SEULE EQUIPE. Autoriser l'appartenance
 *     multiple rendrait le chat d'equipe ambigu : a qui part le message ?
 *
 *  ⚠️ « PRET » SE REMET A FAUX QUAND L'EQUIPE CHANGE. Un joueur qui s'est
 *     declare pret pour une activite, puis change d'equipe, n'a rien promis a
 *     la nouvelle.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const MAX_EQUIPES = 8
const MAX_NOM = 24

/** Couleurs lisibles sur le fond du jeu, et distinguables entre elles. */
const COULEURS = ['or', 'cyan', 'vert', 'ambre', 'rose', 'violet', 'rouge', 'bleu']

function nettoyerNom(texte) {
  return String(texte || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NOM)
}

class Equipes {
  constructor() {
    /** @type {Map<number, {id:number, nom:string, couleur:string, creeLe:number}>} */
    this.table = new Map()
    /** idJoueur -> idEquipe */
    this.appartenance = new Map()
    /** idJoueur -> booleen */
    this.prets = new Map()
    this.prochainId = 1
    this.revision = 0
  }

  get nombre() {
    return this.table.size
  }

  creer(nom) {
    if (this.table.size >= MAX_EQUIPES) return null
    const propre = nettoyerNom(nom)
    if (!propre) return null
    for (const e of this.table.values()) {
      if (e.nom.toLowerCase() === propre.toLowerCase()) return e
    }
    const e = {
      id: this.prochainId++,
      nom: propre,
      couleur: COULEURS[(this.table.size + COULEURS.length) % COULEURS.length],
      creeLe: Date.now(),
    }
    this.table.set(e.id, e)
    this.revision++
    return e
  }

  parNom(nom) {
    const c = String(nom || '').toLowerCase()
    for (const e of this.table.values()) {
      if (e.nom.toLowerCase() === c) return e
    }
    return null
  }

  equipeDe(idJoueur) {
    const id = this.appartenance.get(idJoueur)
    return id ? this.table.get(id) || null : null
  }

  /** Met un joueur dans une equipe. `null` le retire de la sienne. */
  mettre(idJoueur, idEquipe) {
    if (idEquipe === null) {
      this.appartenance.delete(idJoueur)
      this.prets.delete(idJoueur)
      this.revision++
      return true
    }
    if (!this.table.has(idEquipe)) return false
    this.appartenance.set(idJoueur, idEquipe)
    // Changer d'equipe annule la promesse faite a l'ancienne.
    this.prets.delete(idJoueur)
    this.revision++
    return true
  }

  membres(idEquipe) {
    const sortie = []
    for (const [idJoueur, id] of this.appartenance) {
      if (id === idEquipe) sortie.push(idJoueur)
    }
    return sortie
  }

  /** Quand un joueur part, il ne reste pas dans l'equipe. */
  oublier(idJoueur) {
    const avait = this.appartenance.delete(idJoueur)
    this.prets.delete(idJoueur)
    if (avait) this.revision++
    /*
      ⚠️ UNE EQUIPE VIDE DISPARAIT. Sinon la liste se remplit d'equipes de
         personne, et le joueur suivant doit lire dix noms morts pour trouver
         le bon.
    */
    for (const [id] of this.table) {
      if (this.membres(id).length === 0) {
        this.table.delete(id)
        this.revision++
      }
    }
    return avait
  }

  pret(idJoueur, valeur) {
    if (valeur === undefined) return this.prets.get(idJoueur) === true
    this.prets.set(idJoueur, valeur === true)
    this.revision++
    return valeur === true
  }

  /** Tous les joueurs d'une equipe se sont-ils declares prets ? */
  tousPrets(idEquipe) {
    const m = this.membres(idEquipe)
    if (m.length === 0) return false
    return m.every((id) => this.prets.get(id) === true)
  }

  /** Vue envoyee aux clients. */
  instantane() {
    return {
      rev: this.revision,
      equipes: [...this.table.values()].map((e) => ({
        id: e.id,
        nom: e.nom,
        couleur: e.couleur,
        membres: this.membres(e.id),
        prets: this.membres(e.id).filter((id) => this.prets.get(id) === true),
      })),
    }
  }
}

module.exports = { Equipes }
