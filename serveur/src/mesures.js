'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MESURES — ce que le serveur coute vraiment
 * ═══════════════════════════════════════════════════════════════════════════
 *  Paquets, octets, taille d'instantane, duree de tick, memoire, processeur.
 *  Sans ces chiffres, « le serveur rame » reste une impression.
 *
 *  ⚠️ UNE MESURE ABSENTE S'AFFICHE « N/A », JAMAIS ZERO. Un zero se lit comme
 *     une valeur mesuree : « 0 ms de tick » ferait croire a la perfection
 *     alors que rien n'a ete mesure.
 *
 *  ⚠️ ON MESURE AUSSI LE PIRE, PAS SEULEMENT LA MOYENNE. Une moyenne de 2 ms
 *     avec une pointe a 180 ms, c'est un a-coup visible par tous les joueurs —
 *     et la moyenne ne le montre pas.
 *
 *  ⚠️ LES COMPTEURS NE GRANDISSENT PAS SANS FIN. Une fenetre glissante d'une
 *     minute : on compare ce qui se passe maintenant, pas depuis le demarrage.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Combien de durees de tick on garde pour calculer le pire et la moyenne. */
const ECHANTILLONS = 300

/** Largeur de la fenetre glissante, en millisecondes. */
const FENETRE_MS = 60_000

class Mesures {
  constructor() {
    this.demarreLe = Date.now()

    this.paquetsRecus = 0
    this.paquetsEnvoyes = 0
    this.octetsRecus = 0
    this.octetsEnvoyes = 0
    this.paquetsRefuses = 0
    this.paquetsPlafonnes = 0
    this.commandes = 0
    this.evenements = 0
    this.transactions = 0

    /** Fenetre glissante : [{quand, recus, envoyes, octetsR, octetsE}] */
    this.fenetre = []
    this.tranche = this.#nouvelleTranche()

    /** Durees de tick, en millisecondes. */
    this.ticks = []
    this.tailleInstantane = 0
    this.tailleInstantaneMax = 0

    this.dernierCpu = process.cpuUsage()
    this.dernierCpuQuand = Date.now()
    this.cpuPourcent = null
  }

  #nouvelleTranche() {
    return { quand: Date.now(), recus: 0, envoyes: 0, octetsR: 0, octetsE: 0 }
  }

  recu(octets) {
    this.paquetsRecus++
    this.octetsRecus += octets || 0
    this.tranche.recus++
    this.tranche.octetsR += octets || 0
  }

  envoye(octets) {
    this.paquetsEnvoyes++
    this.octetsEnvoyes += octets || 0
    this.tranche.envoyes++
    this.tranche.octetsE += octets || 0
  }

  refuse() {
    this.paquetsRefuses++
  }

  plafonne() {
    this.paquetsPlafonnes++
  }

  /** Duree d'un tick d'instantane, et taille du paquet produit. */
  tick(dureeMs, octets) {
    this.ticks.push(dureeMs)
    if (this.ticks.length > ECHANTILLONS) this.ticks.shift()
    if (octets) {
      this.tailleInstantane = octets
      if (octets > this.tailleInstantaneMax) this.tailleInstantaneMax = octets
    }
  }

  /** A appeler une fois par seconde : fait tourner la fenetre et le processeur. */
  seconde(maintenant = Date.now()) {
    this.fenetre.push(this.tranche)
    this.tranche = this.#nouvelleTranche()
    while (this.fenetre.length && maintenant - this.fenetre[0].quand > FENETRE_MS) {
      this.fenetre.shift()
    }

    /*
      ⚠️ `cpuUsage` EST CUMULATIF. Pris tel quel il monterait pour toujours :
         c'est la DIFFERENCE entre deux lectures, divisee par le temps reel
         ecoule, qui donne un pourcentage.
    */
    const cpu = process.cpuUsage(this.dernierCpu)
    const ecoule = maintenant - this.dernierCpuQuand
    if (ecoule > 0) {
      const microsecondes = cpu.user + cpu.system
      this.cpuPourcent = Math.round((microsecondes / (ecoule * 1000)) * 1000) / 10
    }
    this.dernierCpu = process.cpuUsage()
    this.dernierCpuQuand = maintenant
  }

  #surLaFenetre() {
    if (this.fenetre.length === 0) return null
    let recus = 0
    let envoyes = 0
    let octetsR = 0
    let octetsE = 0
    for (const t of this.fenetre) {
      recus += t.recus
      envoyes += t.envoyes
      octetsR += t.octetsR
      octetsE += t.octetsE
    }
    const secondes = this.fenetre.length
    return {
      secondes,
      paquetsRecusParS: Math.round((recus / secondes) * 10) / 10,
      paquetsEnvoyesParS: Math.round((envoyes / secondes) * 10) / 10,
      entrantKoParS: Math.round((octetsR / secondes / 1024) * 100) / 100,
      sortantKoParS: Math.round((octetsE / secondes / 1024) * 100) / 100,
    }
  }

  #surLesTicks() {
    if (this.ticks.length === 0) return null
    let somme = 0
    let pire = 0
    for (const t of this.ticks) {
      somme += t
      if (t > pire) pire = t
    }
    return {
      echantillons: this.ticks.length,
      moyenneMs: Math.round((somme / this.ticks.length) * 100) / 100,
      pireMs: Math.round(pire * 100) / 100,
    }
  }

  /** `null` partout ou rien n'a encore ete mesure : l'appelant affichera N/A. */
  rapport(extra = {}) {
    const m = process.memoryUsage()
    return {
      deboutDepuisS: Math.round((Date.now() - this.demarreLe) / 1000),
      memoireMo: Math.round(m.rss / 1048576),
      tasMo: Math.round(m.heapUsed / 1048576),
      cpuPourcent: this.cpuPourcent,
      reseau: this.#surLaFenetre(),
      ticks: this.#surLesTicks(),
      instantaneOctets: this.tailleInstantane || null,
      instantaneOctetsMax: this.tailleInstantaneMax || null,
      total: {
        paquetsRecus: this.paquetsRecus,
        paquetsEnvoyes: this.paquetsEnvoyes,
        octetsRecus: this.octetsRecus,
        octetsEnvoyes: this.octetsEnvoyes,
        paquetsRefuses: this.paquetsRefuses,
        paquetsPlafonnes: this.paquetsPlafonnes,
        commandes: this.commandes,
        evenements: this.evenements,
        transactions: this.transactions,
      },
      ...extra,
    }
  }
}

module.exports = { Mesures, ECHANTILLONS, FENETRE_MS }
