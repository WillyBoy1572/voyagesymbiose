'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  QUALITE DE LIEN — ce que le joueur subit vraiment
 * ═══════════════════════════════════════════════════════════════════════════
 *  Un ping moyen ne dit pas grand-chose. Ce qui fait saccader une partie, ce
 *  sont la GIGUE (le ping qui varie) et la PERTE (les paquets qui n'arrivent
 *  jamais). Les deux se mesurent avec ce qu'on a deja : l'horodatage des pings
 *  et les numeros de sequence des positions.
 *
 *  ⚠️ LA PERTE SE DEDUIT DES TROUS, PAS DES PAQUETS RECUS. Le client numerote
 *     ses positions sans trou ; si le serveur passe de 41 a 44, il en a perdu
 *     deux. Compter seulement ce qui arrive ne mesure rien du tout.
 *
 *  ⚠️ LA GIGUE N'EST PAS L'ECART-TYPE DU PING. C'est la variation d'un
 *     intervalle au suivant — la definition de la RFC 3550, celle qu'emploient
 *     les outils de voix. Un ping stable a 200 ms se joue tres bien ; un ping
 *     qui saute de 20 a 120 ms ne se joue pas.
 *
 *  ⚠️ UNE MESURE SANS ECHANTILLON VAUT `null`, PAS ZERO. « 0 % de perte »
 *     affiche avant d'avoir recu le moindre paquet est un mensonge, et c'est
 *     exactement celui qu'on croit.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Combien d'allers-retours on garde pour la gigue. */
const ECHANTILLONS_RTT = 32

/** Sur combien de positions on juge la perte. */
const FENETRE_SEQUENCE = 200

/** Au-dela, un saut de sequence n'est pas une perte : le client a redemarre. */
const SAUT_ABSURDE = 500

class Qualite {
  constructor() {
    /** Derniers allers-retours mesures, en millisecondes. */
    this.rtts = []
    /** Gigue courante, lissee. `null` tant qu'on n'a pas deux mesures. */
    this.gigue = null

    /** Numero de sequence le plus haut vu. */
    this.sequenceMax = -1
    /** Combien de positions sont arrivees depuis le debut de la fenetre. */
    this.recues = 0
    /** La sequence au debut de la fenetre courante. */
    this.sequenceDepart = -1
    /** Perte mesuree sur la fenetre precedente, en pourcentage. `null` = inconnue. */
    this.perte = null
  }

  /**
   * Un aller-retour mesure.
   *
   * ⚠️ ON JETTE LES VALEURS ABSURDES. Une horloge client qui recule, un paquet
   *    qui traine une minute : les garder ferait exploser la moyenne et la
   *    gigue pour toujours.
   */
  allerRetour(ms) {
    if (!Number.isFinite(ms) || ms < 0 || ms > 60_000) return

    const precedent = this.rtts.length ? this.rtts[this.rtts.length - 1] : null
    this.rtts.push(ms)
    if (this.rtts.length > ECHANTILLONS_RTT) this.rtts.shift()

    if (precedent !== null) {
      /*
        Gigue facon RFC 3550 : on lisse la variation d'un intervalle au suivant
        au seizieme. Une pointe isolee ne fait pas sauter la valeur, et une
        liaison qui se degrade se voit en quelques secondes.
      */
      const ecart = Math.abs(ms - precedent)
      this.gigue = this.gigue === null ? ecart : this.gigue + (ecart - this.gigue) / 16
    }
  }

  /**
   * Une position recue, avec son numero de sequence.
   *
   * ⚠️ ON COMPTE LES TROUS, PAS LES ARRIVEES. Et un paquet arrive dans le
   *    desordre n'est pas une perte : il comble un trou deja compte.
   */
  sequence(seq) {
    if (!Number.isInteger(seq) || seq < 0) return

    if (this.sequenceDepart < 0) {
      this.sequenceDepart = seq
      this.sequenceMax = seq
      this.recues = 1
      return
    }

    /*
      ⚠️ UN SAUT ENORME VEUT DIRE « NOUVEAU CLIENT », PAS « MILLE PAQUETS
         PERDUS ». Le pont repart de zero quand il se reconnecte : sans ce
         garde-fou, la perte afficherait 100 % apres chaque reconnexion.
    */
    if (seq < this.sequenceMax - SAUT_ABSURDE || seq > this.sequenceMax + SAUT_ABSURDE) {
      this.sequenceDepart = seq
      this.sequenceMax = seq
      this.recues = 1
      return
    }

    if (seq > this.sequenceMax) this.sequenceMax = seq
    this.recues++

    const attendues = this.sequenceMax - this.sequenceDepart + 1
    if (attendues >= FENETRE_SEQUENCE) {
      const perdues = Math.max(0, attendues - this.recues)
      this.perte = Math.round((perdues / attendues) * 1000) / 10
      // Fenetre suivante : on repart du dernier numero vu.
      this.sequenceDepart = this.sequenceMax
      this.recues = 1
    }
  }

  get rttMoyen() {
    if (this.rtts.length === 0) return null
    return Math.round(this.rtts.reduce((a, b) => a + b, 0) / this.rtts.length)
  }

  get rttPire() {
    if (this.rtts.length === 0) return null
    return Math.round(Math.max(...this.rtts))
  }

  /** Ce qu'on envoie au joueur, et ce que `/admin/joueurs` affiche. */
  rapport() {
    return {
      rtt: this.rttMoyen,
      rttPire: this.rttPire,
      gigue: this.gigue === null ? null : Math.round(this.gigue * 10) / 10,
      perte: this.perte,
      echantillons: this.rtts.length,
    }
  }

  /**
   * Un mot pour dire si ca se joue.
   *
   * ⚠️ LES SEUILS SONT DES REPERES, PAS UNE VERITE. Ils viennent de ce qui se
   *    sent manette en main : au-dela de 150 ms de latence ou de 2 % de perte,
   *    les autres joueurs commencent a sauter visiblement.
   */
  get etat() {
    const rtt = this.rttMoyen
    if (rtt === null) return 'inconnu'
    const perte = this.perte ?? 0
    const gigue = this.gigue ?? 0
    if (rtt > 250 || perte > 5 || gigue > 60) return 'mauvais'
    if (rtt > 150 || perte > 2 || gigue > 30) return 'moyen'
    return 'bon'
  }
}

module.exports = { Qualite }
