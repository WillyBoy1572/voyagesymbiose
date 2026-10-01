'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PNJ — les creatures, et le probleme qu'elles posent vraiment
 * ═══════════════════════════════════════════════════════════════════════════
 *  Le jeu fait apparaitre ses requins, ses anges et ses essaims chez CHAQUE
 *  joueur, independamment. Personne ne les a demandes a un serveur : c'est le
 *  jeu solo qui les simule, dans chaque partie, avec ses propres graines
 *  aleatoires.
 *
 *  ⚠️ IL N'Y A DONC RIEN A « SYNCHRONISER » AU SENS HABITUEL. On ne peut pas
 *     apparier le requin de l'un avec le requin de l'autre : ce ne sont pas
 *     les memes acteurs, ils n'ont pas le meme identifiant, et rien dans le
 *     jeu ne les relie. Pretendre le contraire serait exactement le genre de
 *     fausse fonctionnalite a ne pas livrer.
 *
 *  ⚠️ CE QU'ON PEUT FAIRE, ET QUI EST REEL : un joueur fait autorite, son mod
 *     recense ce qu'il voit, le serveur le garde et le redistribue. Les autres
 *     en font ce qu'ils veulent, et ils ont deux choix honnetes :
 *
 *       « annonce »  on affiche ce que l'hote voit (un requin a 40 m au nord),
 *                    sans toucher a la simulation locale. Rien ne casse.
 *
 *       « miroir »   on supprime ses propres creatures des classes suivies et
 *                    on affiche celles de l'hote. C'est la seule facon de voir
 *                    LE MEME requin — au prix de desactiver l'IA locale, ce
 *                    qui peut perturber les declencheurs du jeu.
 *
 *     Le serveur ne tranche pas : il fournit la donnee, le client choisit.
 *
 *  ⚠️ SEUL L'HOTE EST ECOUTE. Si chacun pouvait declarer des creatures, le
 *     registre contiendrait quatre requins pour un, et n'importe qui pourrait
 *     en inventer.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Au-dela, on cesse d'accepter : un monde n'a pas 500 creatures actives. */
const MAXIMUM = 256

/** Sans nouvelle de l'hote pendant ce delai, la creature est oubliee. */
const OUBLI_MS = 6_000

/**
 * Bandes de pertinence, en centimetres.
 *
 * Plus serrees que celles des objets : une creature bouge vite, et une
 * creature lointaine n'interesse personne.
 *
 * ⚠️ DIX FOIS PAR SECONDE AU PLUS, PAS VINGT. L'hote ne rapporte ses creatures
 *    que deux fois par seconde, et le pont ne depose dans le jeu que dix fois :
 *    les renvoyer a chaque tick ferait voyager deux fois la meme valeur pour
 *    rien, sur le flux le plus gros de l'instantane.
 */
const BANDES = [
  { jusqua: 8000, tousLesNTicks: 2 },
  { jusqua: 25000, tousLesNTicks: 10 },
]

/**
 * Les classes qu'on accepte de suivre.
 *
 * ⚠️ UNE LISTE DE MOTIFS, PAS UNE LISTE DE NOMS. Le jeu se met a jour et
 *    renomme ses blueprints ; un motif survit a `BP_NPC_Shark_C` devenant
 *    `BP_NPC_Shark_V2_C`. Mais il reste ferme : rien d'autre ne passe.
 */
const MOTIFS = [/^BP_NPC_/i, /^BP_Swarm/i, /NPCBaseCharacter$/i, /^BP_Creature/i]

function classeSuivie(nom) {
  const n = String(nom || '')
  if (n.length < 3 || n.length > 64) return false
  return MOTIFS.some((m) => m.test(n))
}

function distance2(a, b) {
  const dx = (a.x || 0) - (b.x || 0)
  const dy = (a.y || 0) - (b.y || 0)
  const dz = (a.z || 0) - (b.z || 0)
  return dx * dx + dy * dy + dz * dz
}

class Pnj {
  constructor(journal) {
    this.journal = journal || (() => {})
    /** cle de l'hote -> creature */
    this.table = new Map()
    /** Qui fait autorite en ce moment. `null` = personne, on n'accepte rien. */
    this.idAutorite = null
    this.prochainId = 1
    this.revision = 0
    /** Evenements a diffuser une fois (mort, apparition), vides a chaque tick. */
    this.evenements = []
  }

  get nombre() {
    return this.table.size
  }

  /** Change d'autorite. Tout ce que l'ancienne avait declare est oublie. */
  changerAutorite(idJoueur) {
    if (this.idAutorite === idJoueur) return
    this.idAutorite = idJoueur
    if (this.table.size) {
      this.table.clear()
      this.revision++
      /*
        ⚠️ ON REPART DE ZERO, ON NE GARDE RIEN. Les creatures de l'ancien hote
           n'existent plus pour le nouveau : son jeu a les siennes. Garder les
           anciennes afficherait des requins fantomes immobiles pour toujours.
      */
      this.evenements.push({ quoi: 'remise-a-zero' })
    }
  }

  /**
   * Un rapport de l'hote. Rend le nombre de creatures retenues.
   *
   * @param {number} idJoueur qui rapporte
   * @param {Array<object>} liste `{cle, classe, pos, rot, vie, etat}`
   */
  rapporter(idJoueur, liste) {
    if (this.idAutorite === null) this.idAutorite = idJoueur
    if (idJoueur !== this.idAutorite) return 0
    if (!Array.isArray(liste)) return 0

    const maintenant = Date.now()
    let retenues = 0

    for (const brut of liste) {
      if (retenues >= MAXIMUM) break
      if (!brut || typeof brut !== 'object') continue
      const cle = String(brut.cle || '').slice(0, 48)
      const classe = String(brut.classe || '').slice(0, 64)
      if (!cle || !classeSuivie(classe)) continue
      const pos = brut.pos
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) continue

      let c = this.table.get(cle)
      if (!c) {
        if (this.table.size >= MAXIMUM) continue
        c = {
          id: this.prochainId++,
          cle,
          classe,
          pos: { x: 0, y: 0, z: 0 },
          rot: { yaw: 0 },
          vie: null,
          etat: null,
          nee: maintenant,
          revision: 0,
        }
        this.table.set(cle, c)
        this.evenements.push({ quoi: 'apparition', id: c.id, classe, pos: { ...pos } })
      }

      c.pos = { x: pos.x, y: pos.y, z: pos.z }
      if (brut.rot && Number.isFinite(brut.rot.yaw)) c.rot = { yaw: brut.rot.yaw }
      if (Number.isFinite(brut.vie)) {
        /*
          ⚠️ UNE VIE QUI TOMBE A ZERO EST UN EVENEMENT, PAS UNE VALEUR. Les
             autres joueurs doivent l'apprendre meme s'ils sont loin : c'est
             l'information utile de toute la partie PNJ.
        */
        if (c.vie !== null && c.vie > 0 && brut.vie <= 0) {
          this.evenements.push({ quoi: 'mort', id: c.id, classe: c.classe, pos: { ...c.pos } })
        }
        c.vie = brut.vie
      }
      if (typeof brut.etat === 'string') c.etat = brut.etat.slice(0, 24)
      c.vuLe = maintenant
      c.revision = ++this.revision
      retenues++
    }

    return retenues
  }

  /** L'hote signale explicitement une disparition. */
  retirer(idJoueur, cle) {
    if (idJoueur !== this.idAutorite) return false
    const c = this.table.get(cle)
    if (!c) return false
    this.table.delete(cle)
    this.revision++
    this.evenements.push({ quoi: 'disparition', id: c.id, classe: c.classe })
    return true
  }

  /** Oublie ce dont l'hote ne parle plus. */
  balayer(maintenant = Date.now()) {
    let combien = 0
    for (const [cle, c] of this.table) {
      if (maintenant - (c.vuLe || c.nee) > OUBLI_MS) {
        this.table.delete(cle)
        this.evenements.push({ quoi: 'disparition', id: c.id, classe: c.classe })
        combien++
      }
    }
    if (combien) this.revision++
    return combien
  }

  /** Prend et vide la file d'evenements. */
  prendreEvenements() {
    if (this.evenements.length === 0) return null
    const e = this.evenements
    this.evenements = []
    return e
  }

  /** Ce qu'un joueur doit recevoir a ce tick. */
  pour(joueur, tick) {
    if (this.table.size === 0) return null
    const ici = joueur.pos || { x: 0, y: 0, z: 0 }
    const sortie = []
    for (const c of this.table.values()) {
      const d2 = distance2(ici, c.pos)
      let bande = null
      for (const b of BANDES) {
        if (d2 <= b.jusqua * b.jusqua) {
          bande = b
          break
        }
      }
      if (!bande) continue
      if (tick % bande.tousLesNTicks !== 0) continue
      sortie.push({
        id: c.id,
        c: c.classe,
        pos: c.pos,
        rot: c.rot,
        vie: c.vie,
        etat: c.etat,
      })
    }
    return sortie.length ? sortie : null
  }

  /** Vue de diagnostic. */
  toutes() {
    return [...this.table.values()].map((c) => ({
      id: c.id,
      classe: c.classe,
      pos: c.pos,
      vie: c.vie,
      etat: c.etat,
    }))
  }
}

module.exports = { Pnj, classeSuivie, MOTIFS, MAXIMUM, OUBLI_MS, BANDES }
