'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ENTITES — tout ce qui existe dans la partie sans etre un joueur
 * ═══════════════════════════════════════════════════════════════════════════
 *  Une porte ouverte, une machine allumee, un objet pose, un PNJ, un morceau
 *  de construction : tout passe par ici. Les joueurs ont leur propre chemin
 *  (ils arrivent 10 fois par seconde et n'ont pas besoin de revision) ; le
 *  reste du monde vit dans ce registre.
 *
 *  ⚠️ LE SERVEUR DECIDE, LE CLIENT DEMANDE. Un client n'ecrit jamais dans le
 *     registre : il envoie une intention, le serveur verifie l'autorite, puis
 *     applique. Sans ca, ouvrir une porte chez soi suffirait a la fermer chez
 *     les autres — ou a faire apparaitre dix objets d'un coup.
 *
 *  ⚠️ CHAQUE MODIFICATION PORTE UNE CLE DE TRANSACTION, ET LA MEME CLE NE
 *     S'APPLIQUE QU'UNE FOIS. L'UDP perd et duplique : un client qui renvoie
 *     sa demande parce qu'il n'a pas vu la reponse ne doit pas fabriquer un
 *     deuxieme objet. On rend le resultat deja calcule.
 *
 *  ⚠️ ON N'ENVOIE PAS TOUT LE MONDE A TOUT LE MONDE. Au-dela de quelques
 *     dizaines d'entites, diffuser l'integralite a chaque tick sature la
 *     bande passante pour des objets que personne ne regarde. Chacun recoit
 *     ce qui est pres de lui, souvent ; ce qui est loin, rarement.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Bandes de pertinence, en centimetres (l'unite d'Unreal).
 *
 * Les valeurs sont un point de depart raisonnable, pas une verite : elles
 * doivent etre mesurees sur une vraie partie. `tousLesNTicks` vaut 1 pour
 * « a chaque instantane ».
 */
const BANDES = [
  { nom: 'proche', jusqua: 5000, tousLesNTicks: 1 },
  { nom: 'moyen', jusqua: 20000, tousLesNTicks: 4 },
  { nom: 'loin', jusqua: 60000, tousLesNTicks: 20 },
]

/** Au-dela de la derniere bande, on n'envoie rien du tout. */
const HORS_PORTEE = null

/** Une cle de transaction ne sert plus a rien passe ce delai. */
const MEMOIRE_TRANSACTIONS_MS = 60_000

/** Types connus. Un type inconnu est refuse : on ne replique pas n'importe quoi. */
const TYPES = new Set(['objet', 'porte', 'machine', 'construction', 'pnj', 'marqueur'])

function distance2(a, b) {
  const dx = (a.x || 0) - (b.x || 0)
  const dy = (a.y || 0) - (b.y || 0)
  const dz = (a.z || 0) - (b.z || 0)
  return dx * dx + dy * dy + dz * dz
}

class Entites {
  constructor(config, journal) {
    this.config = config
    this.journal = journal || (() => {})
    /** @type {Map<number, object>} */
    this.table = new Map()
    this.prochainId = 1
    this.revision = 0
    /** cle de transaction -> { resultat, quand } */
    this.transactions = new Map()
  }

  get nombre() {
    return this.table.size
  }

  /**
   * Rejoue une demande deja traitee au lieu de la refaire.
   *
   * Rend `{ deja, resultat }`. `deja` dit a l'appelant qu'il ne doit rien
   * executer : le resultat est celui de la premiere fois.
   */
  rejouer(cle) {
    if (!cle) return { deja: false, resultat: null }
    const vu = this.transactions.get(cle)
    if (!vu) return { deja: false, resultat: null }
    return { deja: true, resultat: vu.resultat }
  }

  retenir(cle, resultat) {
    if (!cle) return resultat
    this.transactions.set(cle, { resultat, quand: Date.now() })
    return resultat
  }

  /** Les cles trop vieilles ne servent plus qu'a remplir la memoire. */
  oublierLesVieillesTransactions(maintenant = Date.now()) {
    for (const [cle, v] of this.transactions) {
      if (maintenant - v.quand > MEMOIRE_TRANSACTIONS_MS) this.transactions.delete(cle)
    }
  }

  creer({ type, pos, rot, etat, proprietaire = null, duree = 0 }) {
    if (!TYPES.has(type)) return null

    const e = {
      id: this.prochainId++,
      type,
      pos: { x: pos?.x || 0, y: pos?.y || 0, z: pos?.z || 0 },
      rot: { yaw: rot?.yaw || 0 },
      etat: etat && typeof etat === 'object' ? { ...etat } : {},
      proprietaire,
      revision: ++this.revision,
      nee: Date.now(),
      /** 0 = eternelle. Sinon, millisecondes de vie. */
      duree,
    }
    this.table.set(e.id, e)
    return e
  }

  supprimer(id) {
    const e = this.table.get(id)
    if (!e) return false
    this.table.delete(id)
    this.revision++
    return true
  }

  /**
   * Qui a le droit de toucher a cette entite ?
   *
   * ⚠️ UNE ENTITE SANS PROPRIETAIRE APPARTIENT AU SERVEUR, PAS A TOUT LE
   *    MONDE. C'est le cas des portes et des machines : elles ne sont a
   *    personne, et c'est justement pour ca que n'importe qui peut demander
   *    a les actionner -- mais c'est le serveur qui applique.
   */
  autorise(e, joueur, intention) {
    if (!e) return false
    if (!joueur) return true // le serveur lui-meme
    if (intention === 'actionner') return e.proprietaire === null || e.proprietaire === joueur.id
    return e.proprietaire === joueur.id
  }

  /**
   * Applique une modification demandee par un joueur.
   * Rend l'entite modifiee, ou `null` si refusee.
   */
  modifier(id, changements, joueur, intention = 'actionner') {
    const e = this.table.get(id)
    if (!e) return null
    if (!this.autorise(e, joueur, intention)) return null

    if (changements.pos) {
      e.pos = {
        x: Number(changements.pos.x) || 0,
        y: Number(changements.pos.y) || 0,
        z: Number(changements.pos.z) || 0,
      }
    }
    if (changements.rot) e.rot = { yaw: Number(changements.rot.yaw) || 0 }
    if (changements.etat && typeof changements.etat === 'object') {
      e.etat = { ...e.etat, ...changements.etat }
    }

    e.revision = ++this.revision
    return e
  }

  /**
   * Transfert de propriete.
   *
   * ⚠️ ELLE DOIT SURVIVRE AU DEPART DU PROPRIETAIRE. Un objet dont le
   *    proprietaire se deconnecte resterait sinon verrouille pour toujours :
   *    plus personne ne pourrait y toucher, et rien ne le dirait.
   */
  donner(id, nouveauProprietaire) {
    const e = this.table.get(id)
    if (!e) return null
    e.proprietaire = nouveauProprietaire
    e.revision = ++this.revision
    return e
  }

  /** Libere tout ce qui appartenait a un joueur qui s'en va. */
  libererCeuxDe(idJoueur) {
    let combien = 0
    for (const e of this.table.values()) {
      if (e.proprietaire === idJoueur) {
        e.proprietaire = null
        e.revision = ++this.revision
        combien++
      }
    }
    return combien
  }

  /** Retire les entites dont la duree de vie est passee. */
  balayer(maintenant = Date.now()) {
    let combien = 0
    for (const [id, e] of this.table) {
      if (e.duree > 0 && maintenant - e.nee > e.duree) {
        this.table.delete(id)
        combien++
      }
    }
    if (combien) this.revision++
    this.oublierLesVieillesTransactions(maintenant)
    return combien
  }

  /**
   * Ce qu'un joueur doit recevoir a ce tick.
   *
   * ⚠️ ON COMPARE DES CARRES DE DISTANCE. Une racine carree par entite et par
   *    joueur et par tick, c'est des milliers d'operations par seconde pour
   *    un resultat qu'on ne fait que comparer.
   */
  pour(joueur, tick) {
    if (this.table.size === 0) return null
    const ici = joueur.pos || { x: 0, y: 0, z: 0 }
    const sortie = []

    for (const e of this.table.values()) {
      const d2 = distance2(ici, e.pos)
      let bande = HORS_PORTEE
      for (const b of BANDES) {
        if (d2 <= b.jusqua * b.jusqua) {
          bande = b
          break
        }
      }
      if (bande === HORS_PORTEE) continue
      if (tick % bande.tousLesNTicks !== 0) continue

      sortie.push({
        id: e.id,
        type: e.type,
        pos: e.pos,
        rot: e.rot,
        etat: e.etat,
        proprietaire: e.proprietaire,
        rev: e.revision,
      })
    }

    return sortie.length ? sortie : null
  }

  /** Vue complete, pour l'API HTTP et le diagnostic. */
  toutes() {
    return [...this.table.values()].map((e) => ({
      id: e.id,
      type: e.type,
      pos: e.pos,
      proprietaire: e.proprietaire,
      rev: e.revision,
    }))
  }
}

module.exports = { Entites, BANDES, TYPES }
