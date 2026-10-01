'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TEMPS — une seule horloge pour tout le monde
 * ═══════════════════════════════════════════════════════════════════════════
 *  Chaque joueur charge SA sauvegarde : l'un est a l'aube, l'autre en pleine
 *  nuit. Deux amis sur le meme radeau ne voient alors pas le meme ciel, et
 *  rien dans le jeu ne les rapproche.
 *
 *  ⚠️ LE SERVEUR TIENT L'HEURE, LE CLIENT LA POSE — S'IL PEUT. On ne sait pas
 *     a l'avance si le jeu accepte qu'on ecrive son heure : le mod essaie, et
 *     dit ce qu'il a reussi. Tant qu'il ne peut pas, l'heure du serveur sert
 *     quand meme : elle s'affiche, et le chat l'annonce.
 *
 *  ⚠️ ON N'ECRASE PAS LE MONDE DU JOUEUR A L'AVEUGLE. Imposer l'heure au
 *     moment ou il charge sa partie pourrait court-circuiter une sequence du
 *     jeu. Le mod attend d'etre en partie, puis corrige par petits pas quand
 *     l'ecart est faible, et d'un coup seulement quand il est grand.
 *
 *  ⚠️ L'HORLOGE AVANCE TOUTE SEULE, OU PAS DU TOUT. `CYCLE_MINUTES=0` la
 *     fige : c'est le bon reglage pour une partie ou l'hote veut decider de
 *     l'heure a la main.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Les meteos qu'on accepte de piloter. Fermee : on ne diffuse pas n'importe quoi. */
const METEOS = ['clair', 'nuageux', 'brume', 'pluie', 'orage', 'tempete']

/**
 * Enchainements plausibles. Une tempete ne tombe pas sur un ciel clair sans
 * passer par les nuages — et une meteo qui saute au hasard a l'air cassee.
 */
const SUITES = {
  clair: ['clair', 'nuageux'],
  nuageux: ['clair', 'nuageux', 'brume', 'pluie'],
  brume: ['nuageux', 'clair'],
  pluie: ['nuageux', 'pluie', 'orage'],
  orage: ['pluie', 'orage', 'tempete'],
  tempete: ['orage', 'pluie'],
}

class Temps {
  /**
   * @param {object} config
   * @param {import('./monde').Monde} monde
   * @param {(texte: string) => void} [annoncer]
   */
  constructor(config, monde, annoncer) {
    this.config = config
    this.monde = monde
    this.annoncer = annoncer || (() => {})
    /** Minutes de jeu par minute reelle. 0 = horloge figee. */
    this.cadence = config.cycleMinutes || 0
    /** Meteo pilotee par le serveur, ou laissee a l'hote. */
    this.meteoAuto = Boolean(config.meteoAuto)
    this.dernierPas = Date.now()
    this.dernierChangementMeteo = Date.now()
    /** Nombre de jours ecoules depuis le demarrage : utile aux activites. */
    this.jour = 1
  }

  /**
   * Fait avancer l'horloge. A appeler une fois par seconde.
   *
   * ⚠️ ON MESURE LE TEMPS ECOULE, ON NE COMPTE PAS LES APPELS. Une minuterie
   *    Node derive, et un serveur charge la rate : compter les appels ferait
   *    des journees de longueur variable.
   */
  avancer(maintenant = Date.now()) {
    if (this.cadence <= 0) return false

    const ecoule = maintenant - this.dernierPas
    if (ecoule < 1000) return false
    this.dernierPas = maintenant

    const minutes = (ecoule / 60_000) * this.cadence
    if (minutes <= 0) return false

    let total = this.monde.heure * 60 + this.monde.minute + minutes
    let jours = 0
    while (total >= 1440) {
      total -= 1440
      jours++
    }
    if (jours) {
      this.jour += jours
      this.annoncer(`Jour ${this.jour}.`)
    }

    const h = Math.floor(total / 60) % 24
    const m = Math.floor(total % 60)
    if (h !== this.monde.heure || m !== this.monde.minute) {
      this.monde.reglerHeure(h, m)
      return true
    }
    return false
  }

  /**
   * Fait evoluer la meteo, si le serveur la pilote.
   *
   * ⚠️ UN CHANGEMENT PAR QUART D'HEURE AU PLUS. Une meteo qui change toutes
   *    les minutes donne l'impression que le serveur deraille — et chaque
   *    changement est un paquet de monde envoye a tous.
   */
  evoluerMeteo(maintenant = Date.now()) {
    if (!this.meteoAuto) return false
    if (maintenant - this.dernierChangementMeteo < 900_000) return false
    this.dernierChangementMeteo = maintenant

    const actuelle = METEOS.includes(this.monde.meteo) ? this.monde.meteo : 'clair'
    const possibles = SUITES[actuelle] || ['clair']
    const suivante = possibles[Math.floor(Math.random() * possibles.length)]
    if (suivante === actuelle) return false

    this.monde.reglerMeteo(suivante)
    this.annoncer(`La météo passe à « ${suivante} ».`)
    return true
  }

  /**
   * L'horloge telle qu'elle part aux clients.
   *
   * `ms` donne au client de quoi interpoler entre deux instantanes : sans lui
   *  l'heure sauterait par paliers d'une minute.
   */
  instantane() {
    return {
      heure: this.monde.heure,
      minute: this.monde.minute,
      jour: this.jour,
      cadence: this.cadence,
      meteo: this.monde.meteo,
      /** Horloge murale du serveur : sert a mesurer la latence et a dater. */
      ms: Date.now(),
    }
  }
}

module.exports = { Temps, METEOS, SUITES }
