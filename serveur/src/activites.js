'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ACTIVITES — se donner un but ensemble
 * ═══════════════════════════════════════════════════════════════════════════
 *  « Réparer le générateur », « Récupérer le composant », « Atteindre le
 *  port » : une activite est un objectif partage, avec des etapes, un etat et
 *  un compte a rebours facultatif.
 *
 *  ⚠️ LE SERVEUR NE SAIT PAS CE QUE FAIT LE JOUEUR DANS LE JEU. Il ne peut
 *     donc pas decider seul qu'une etape est franchie : c'est le mod qui le
 *     signale, et le serveur qui l'enregistre. Une activite n'est pas une
 *     quete du jeu, c'est une feuille de route partagee.
 *
 *  ⚠️ RIEN N'EST INVENTE. Une etape ne se coche que si quelqu'un l'a
 *     signalee. Une activite affichee comme reussie alors que personne n'a
 *     rien fait serait pire qu'une absence d'activite.
 *
 *  ⚠️ LES ACTIVITES NE SURVIVENT PAS AU REDEMARRAGE. Comme les equipes :
 *     elles vivent le temps d'une soiree.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const MAX_ACTIVITES = 16
const MAX_ETAPES = 12
const MAX_TEXTE = 80

const ETATS = ['proposee', 'en-cours', 'reussie', 'abandonnee', 'echouee']

function texte(v, max = MAX_TEXTE) {
  return String(v || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

class Activites {
  constructor(journal) {
    this.journal = journal || (() => {})
    /** @type {Map<number, object>} */
    this.table = new Map()
    this.prochainId = 1
    this.revision = 0
  }

  get nombre() {
    return this.table.size
  }

  /**
   * Cree une activite. Les etapes sont des libelles ; rien d'automatique.
   */
  creer({ titre, etapes = [], parQui = '?', idEquipe = null, dureeMs = 0 }) {
    if (this.table.size >= MAX_ACTIVITES) return null
    const t = texte(titre)
    if (!t) return null

    const liste = (Array.isArray(etapes) ? etapes : [])
      .map((e) => texte(e))
      .filter(Boolean)
      .slice(0, MAX_ETAPES)
      .map((libelle, i) => ({ n: i + 1, libelle, faite: false, parQui: null, quand: 0 }))

    const a = {
      id: this.prochainId++,
      titre: t,
      etapes: liste,
      etat: 'proposee',
      parQui: texte(parQui, 24),
      idEquipe: Number.isInteger(idEquipe) ? idEquipe : null,
      creeLe: Date.now(),
      demarreLe: 0,
      finiLe: 0,
      /** 0 = sans limite de temps. */
      dureeMs: Number.isFinite(dureeMs) && dureeMs > 0 ? Math.min(dureeMs, 86_400_000) : 0,
      revision: ++this.revision,
    }
    this.table.set(a.id, a)
    return a
  }

  demarrer(id) {
    const a = this.table.get(id)
    if (!a || a.etat !== 'proposee') return null
    a.etat = 'en-cours'
    a.demarreLe = Date.now()
    a.revision = ++this.revision
    return a
  }

  /**
   * Coche une etape. Rend l'activite, ou `null`.
   *
   * ⚠️ UNE ETAPE DEJA FAITE NE SE REFAIT PAS. L'UDP duplique, et le mod peut
   *    signaler deux fois : sans ce test, le compte d'etapes depasserait le
   *    total.
   */
  cocher(id, numero, parQui) {
    const a = this.table.get(id)
    if (!a || a.etat !== 'en-cours') return null
    const e = a.etapes.find((x) => x.n === numero)
    if (!e || e.faite) return null
    e.faite = true
    e.parQui = texte(parQui, 24)
    e.quand = Date.now()
    a.revision = ++this.revision

    if (a.etapes.every((x) => x.faite)) {
      a.etat = 'reussie'
      a.finiLe = Date.now()
    }
    return a
  }

  finir(id, etat) {
    const a = this.table.get(id)
    if (!a) return null
    if (!ETATS.includes(etat)) return null
    a.etat = etat
    a.finiLe = Date.now()
    a.revision = ++this.revision
    return a
  }

  supprimer(id) {
    const existait = this.table.delete(id)
    if (existait) this.revision++
    return existait
  }

  /**
   * Fait echouer ce qui a depasse son temps, et oublie ce qui est fini depuis
   * longtemps.
   */
  balayer(maintenant = Date.now()) {
    let change = 0
    for (const [id, a] of this.table) {
      if (a.etat === 'en-cours' && a.dureeMs > 0 && maintenant - a.demarreLe > a.dureeMs) {
        a.etat = 'echouee'
        a.finiLe = maintenant
        a.revision = ++this.revision
        change++
      }
      // Une activite finie reste affichee dix minutes, puis s'effface.
      if (a.finiLe && maintenant - a.finiLe > 600_000) {
        this.table.delete(id)
        change++
      }
    }
    if (change) this.revision++
    return change
  }

  instantane() {
    return {
      rev: this.revision,
      activites: [...this.table.values()].map((a) => ({
        id: a.id,
        titre: a.titre,
        etat: a.etat,
        parQui: a.parQui,
        idEquipe: a.idEquipe,
        etapes: a.etapes.map((e) => ({ n: e.n, libelle: e.libelle, faite: e.faite, parQui: e.parQui })),
        reste: a.dureeMs && a.demarreLe ? Math.max(0, a.dureeMs - (Date.now() - a.demarreLe)) : 0,
      })),
    }
  }
}

module.exports = { Activites }
