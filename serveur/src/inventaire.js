'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INVENTAIRE — ce que chacun porte, et le coffre commun
 * ═══════════════════════════════════════════════════════════════════════════
 *  Deux choses tres differentes vivent ici, et il faut les distinguer avant
 *  d'ecrire une ligne :
 *
 *  1. LE MIROIR. Chaque joueur declare ce qu'il porte. Le serveur le garde et
 *     le redistribue : « Willy a 12 ferraille, 2 batteries ». C'est de la
 *     lecture, rien de plus. Le jeu reste maitre de son inventaire.
 *
 *  2. LE COFFRE COMMUN. Un vrai depot tenu par le serveur. On y DEPOSE (le
 *     mod retire l'objet du jeu, le serveur le credite) et on en RETIRE (le
 *     serveur debite, le mod ajoute l'objet au jeu). C'est la seule chose qui
 *     permette d'echanger des objets entre deux parties separees.
 *
 *  ⚠️ L'INVENTAIRE DU JEU N'EST PAS SYNCHRONISABLE DIRECTEMENT, ET LE
 *     PRETENDRE SERAIT MENTIR. Chaque joueur charge SA sauvegarde, avec SES
 *     objets ; rien dans le jeu ne relie son sac a celui d'un autre. Le miroir
 *     montre, le coffre echange — il n'y a pas de troisieme possibilite
 *     honnete.
 *
 *  ⚠️ LE SERVEUR DEBITE AVANT QUE QUICONQUE RECOIVE. C'est tout l'enjeu de la
 *     duplication : si on prevenait le receveur d'abord, un paquet perdu au
 *     retour laisserait l'objet dans le coffre ET dans le sac. On ote d'abord,
 *     on annonce ensuite, et si l'ajout echoue le mod le rend au coffre.
 *
 *  ⚠️ CHAQUE MOUVEMENT PORTE UNE CLE, ET LA MEME CLE NE BOUGE RIEN DEUX FOIS.
 *     L'UDP duplique et le client renvoie quand il ne voit pas de reponse.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const fs = require('node:fs')
const path = require('node:path')

/** Combien d'especes d'objets differentes le coffre peut contenir. */
const ESPECES_MAX = 120

/** Plafond par espece. Au-dela, c'est un bogue ou une tricherie. */
const PAR_ESPECE_MAX = 100_000

/** Combien d'objets differents on accepte dans le miroir d'un joueur. */
const MIROIR_MAX = 80

/** Une cle de mouvement ne sert plus a rien passe ce delai. */
const MEMOIRE_MS = 120_000

/** Combien de mouvements on garde dans le journal du coffre. */
const JOURNAL_MAX = 400

function nomObjet(v) {
  const propre = String(v || '')
    .replace(/[^\w .'-]/g, '')
    .trim()
    .slice(0, 48)
  return propre || null
}

function quantite(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(Math.floor(n), PAR_ESPECE_MAX))
}

class Inventaires {
  constructor(config, journal) {
    this.config = config
    this.journal = journal || (() => {})
    this.fichier = path.join(config.dossierDonnees, 'coffre.json')
    /** idJoueur -> { objets: Map<nom, nombre>, poids, revision } */
    this.miroirs = new Map()
    /** nom -> nombre. Le coffre commun, tenu par le serveur. */
    this.coffre = new Map()
    /** Journal des mouvements, pour que l'hote puisse comprendre un ecart. */
    this.mouvements = []
    /** cle -> { resultat, quand } */
    this.transactions = new Map()
    this.revision = 0
    this.sale = false
    this.#charger()
  }

  // ── Disque : seul le coffre est durable ─────────────────────────────────

  #charger() {
    try {
      const brut = JSON.parse(fs.readFileSync(this.fichier, 'utf8'))
      for (const [nom, n] of Object.entries(brut.coffre || {})) {
        const propre = nomObjet(nom)
        const q = quantite(n)
        if (propre && q > 0) this.coffre.set(propre, q)
      }
      for (const m of (brut.mouvements || []).slice(-JOURNAL_MAX)) {
        if (m && typeof m.objet === 'string') this.mouvements.push(m)
      }
      if (this.coffre.size) this.journal(`coffre commun : ${this.coffre.size} espèce(s) d’objet.`)
    } catch {
      /* premier demarrage */
    }
  }

  enregistrerSiBesoin() {
    if (!this.sale) return false
    try {
      fs.mkdirSync(path.dirname(this.fichier), { recursive: true })
      const corps = JSON.stringify(
        {
          coffre: Object.fromEntries(this.coffre),
          mouvements: this.mouvements.slice(-JOURNAL_MAX),
        },
        null,
        2,
      )
      const abri = `${this.fichier}.tmp`
      fs.writeFileSync(abri, corps, 'utf8')
      fs.renameSync(abri, this.fichier)
      this.sale = false
      return true
    } catch (e) {
      this.journal(`coffre non enregistré : ${e.message}`)
      return false
    }
  }

  // ── Idempotence ─────────────────────────────────────────────────────────

  rejouer(cle) {
    if (!cle) return { deja: false, resultat: null }
    const vu = this.transactions.get(cle)
    return vu ? { deja: true, resultat: vu.resultat } : { deja: false, resultat: null }
  }

  retenir(cle, resultat) {
    if (cle) this.transactions.set(cle, { resultat, quand: Date.now() })
    return resultat
  }

  // ── 1. Le miroir ────────────────────────────────────────────────────────

  /**
   * Un joueur declare ce qu'il porte.
   *
   * ⚠️ C'EST UNE DECLARATION, PAS UNE VERITE. Le serveur ne peut pas la
   *    verifier : il ne voit pas le jeu. On s'en sert pour afficher, jamais
   *    pour autoriser un retrait du coffre.
   */
  declarer(idJoueur, objets) {
    if (!Array.isArray(objets)) return 0
    const table = new Map()
    for (const o of objets) {
      if (table.size >= MIROIR_MAX) break
      if (!o || typeof o !== 'object') continue
      const nom = nomObjet(o.nom ?? o.n)
      const q = quantite(o.nombre ?? o.q ?? 1)
      if (!nom || q <= 0) continue
      table.set(nom, (table.get(nom) || 0) + q)
    }
    this.miroirs.set(idJoueur, { objets: table, quand: Date.now(), revision: ++this.revision })
    return table.size
  }

  /** Ce que porte un joueur, pour affichage. */
  miroir(idJoueur) {
    const m = this.miroirs.get(idJoueur)
    if (!m) return null
    return {
      objets: [...m.objets.entries()].map(([nom, nombre]) => ({ nom, nombre })),
      quand: m.quand,
    }
  }

  oublier(idJoueur) {
    this.miroirs.delete(idJoueur)
  }

  // ── 2. Le coffre commun ─────────────────────────────────────────────────

  contenu() {
    return [...this.coffre.entries()]
      .map(([nom, nombre]) => ({ nom, nombre }))
      .sort((a, b) => b.nombre - a.nombre)
  }

  /**
   * Le joueur a retire l'objet de son jeu : on le credite.
   *
   * Rend `{ok, nom, nombre, dansLeCoffre}` ou `{refus}`.
   */
  deposer({ nom, nombre, parQui }) {
    const propre = nomObjet(nom)
    const q = quantite(nombre)
    if (!propre || q <= 0) return { refus: 'objet_invalide' }

    const actuel = this.coffre.get(propre) || 0
    if (actuel === 0 && this.coffre.size >= ESPECES_MAX) return { refus: 'coffre_plein' }
    if (actuel + q > PAR_ESPECE_MAX) return { refus: 'trop' }

    this.coffre.set(propre, actuel + q)
    this.revision++
    this.sale = true
    this.#noterMouvement('depot', propre, q, parQui)
    return { ok: true, nom: propre, nombre: q, dansLeCoffre: actuel + q }
  }

  /**
   * Le joueur demande un objet : on le debite D'ABORD, puis le mod l'ajoute.
   *
   * ⚠️ L'ORDRE EST LA SEULE PROTECTION CONTRE LA DUPLICATION. Debiter apres
   *    avoir vu l'objet apparaitre chez le joueur demanderait une confirmation
   *    fiable — l'UDP n'en donne pas.
   */
  retirer({ nom, nombre, parQui }) {
    const propre = nomObjet(nom)
    const q = quantite(nombre)
    if (!propre || q <= 0) return { refus: 'objet_invalide' }

    const actuel = this.coffre.get(propre) || 0
    if (actuel < q) return { refus: 'pas_assez', dansLeCoffre: actuel }

    const reste = actuel - q
    if (reste === 0) this.coffre.delete(propre)
    else this.coffre.set(propre, reste)
    this.revision++
    this.sale = true
    this.#noterMouvement('retrait', propre, q, parQui)
    return { ok: true, nom: propre, nombre: q, dansLeCoffre: reste }
  }

  /**
   * Le mod n'a pas reussi a donner l'objet au joueur : on le remet.
   *
   * ⚠️ CE CHEMIN EXISTE PARCE QUE L'AJOUT PEUT ECHOUER. Sac plein, objet
   *    inconnu du jeu, partie fermee entre-temps : sans retour, l'objet
   *    disparaitrait pour tout le monde.
   */
  rendre({ nom, nombre, parQui }) {
    const r = this.deposer({ nom, nombre, parQui })
    if (r.ok) this.#noterMouvement('retour', r.nom, r.nombre, parQui)
    return r
  }

  #noterMouvement(quoi, objet, nombre, parQui) {
    this.mouvements.push({
      quoi,
      objet,
      nombre,
      parQui: String(parQui || '?').slice(0, 24),
      quand: Date.now(),
    })
    if (this.mouvements.length > JOURNAL_MAX) {
      this.mouvements = this.mouvements.slice(-JOURNAL_MAX)
    }
  }

  journalRecent(combien = 20) {
    return this.mouvements.slice(-combien).reverse()
  }

  balayer(maintenant = Date.now()) {
    for (const [cle, v] of this.transactions) {
      if (maintenant - v.quand > MEMOIRE_MS) this.transactions.delete(cle)
    }
    /*
      ⚠️ UN MIROIR TROP VIEUX EST PIRE QUE PAS DE MIROIR. Il montrerait ce que
         quelqu'un portait il y a dix minutes comme si c'etait maintenant.
    */
    for (const [id, m] of this.miroirs) {
      if (maintenant - m.quand > 60_000) this.miroirs.delete(id)
    }
    this.enregistrerSiBesoin()
  }

  instantane() {
    return { rev: this.revision, coffre: this.contenu().slice(0, 40) }
  }
}

module.exports = { Inventaires, nomObjet, quantite, ESPECES_MAX, PAR_ESPECE_MAX }
