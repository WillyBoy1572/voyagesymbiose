'use strict'

const { chaine, vecteur } = require('./protocole')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  L'ETAT DU MONDE, TENU PAR LE SERVEUR
 * ═══════════════════════════════════════════════════════════════════════════
 *  Meteo, heure, donnees libres, reperes et points d'interaction. C'est le
 *  serveur qui fait autorite : un client qui pretend qu'il est midi n'est pas
 *  cru, il est ignore.
 *
 *  ⚠️ LES IDENTIFIANTS SONT DES ENTIERS CROISSANTS, JAMAIS LA POSITION DANS
 *     UN TABLEAU. Retirer le repere n°2 decalerait tous les suivants, et le
 *     client qui voulait effacer le n°3 effacerait le n°4.
 *
 *  ⚠️ LE NOMBRE D'OBJETS EST PLAFONNE. Sans plafond, une boucle `/mark` d'un
 *     joueur distrait gonfle chaque instantane envoye a tout le monde, et la
 *     partie rame sans que personne ne comprenne pourquoi.
 */

const MAX_REPERES = 200
const MAX_CHECKPOINTS = 100

class Monde {
  constructor() {
    this.meteo = 'clair'
    this.heure = 12
    this.minute = 0
    /** Donnees libres posees par l'hote : titre du jour, consigne, etc. */
    this.donnees = new Map()
    this.reperes = new Map()
    this.checkpoints = new Map()
    this.prochainId = 1
    /** Change des que quelque chose bouge : sert a n'envoyer le monde que s'il a change. */
    this.revision = 0
  }

  #change() {
    this.revision++
  }

  // ── Meteo et heure ──────────────────────────────────────────────────────

  reglerMeteo(nom) {
    const v = chaine(nom, 24)
    if (!v) return null
    this.meteo = v.toLowerCase()
    this.#change()
    return this.meteo
  }

  reglerHeure(heure, minute = 0) {
    if (!Number.isInteger(heure) || heure < 0 || heure > 23) return null
    this.heure = heure
    this.minute = Number.isInteger(minute) && minute >= 0 && minute <= 59 ? minute : 0
    this.#change()
    return { heure: this.heure, minute: this.minute }
  }

  // ── Donnees libres ──────────────────────────────────────────────────────

  poserDonnee(cle, valeur) {
    const c = chaine(cle, 48)
    if (!c) return null
    if (valeur === null || valeur === undefined || valeur === '') {
      this.donnees.delete(c)
      this.#change()
      return { cle: c, valeur: null }
    }
    const v = chaine(String(valeur), 240)
    if (!v) return null
    // 64 cles suffisent largement ; au-dela c'est un script qui fuit.
    if (!this.donnees.has(c) && this.donnees.size >= 64) return null
    this.donnees.set(c, v)
    this.#change()
    return { cle: c, valeur: v }
  }

  // ── Reperes ─────────────────────────────────────────────────────────────

  poserRepere(pos, libelle, parQui) {
    const p = vecteur(pos)
    if (!p) return null
    if (this.reperes.size >= MAX_REPERES) return null
    const id = this.prochainId++
    const r = { id, pos: p, libelle: chaine(libelle, 40) ?? `repere ${id}`, par: parQui ?? null }
    this.reperes.set(id, r)
    this.#change()
    return r
  }

  retirerRepere(id) {
    const ok = this.reperes.delete(id)
    if (ok) this.#change()
    return ok
  }

  // ── Points d'interaction ────────────────────────────────────────────────

  poserCheckpoint(pos, rayon, libelle) {
    const p = vecteur(pos)
    if (!p) return null
    if (this.checkpoints.size >= MAX_CHECKPOINTS) return null
    const r = Number.isFinite(rayon) ? Math.min(Math.max(rayon, 1), 200) : 5
    const id = this.prochainId++
    const c = { id, pos: p, rayon: r, libelle: chaine(libelle, 40) ?? `point ${id}` }
    this.checkpoints.set(id, c)
    this.#change()
    return c
  }

  retirerCheckpoint(id) {
    const ok = this.checkpoints.delete(id)
    if (ok) this.#change()
    return ok
  }

  /** L'etat complet, tel qu'il part dans un instantane ou une reponse HTTP. */
  instantane() {
    return {
      revision: this.revision,
      meteo: this.meteo,
      heure: this.heure,
      minute: this.minute,
      donnees: Object.fromEntries(this.donnees),
      reperes: [...this.reperes.values()],
      checkpoints: [...this.checkpoints.values()],
    }
  }
}

module.exports = { Monde }
