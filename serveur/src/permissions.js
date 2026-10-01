'use strict'

/*
  ⚠️ ICI, `t` PARLE LA LANGUE DU SERVEUR. Ces textes-la vont dans la console
     et dans les journaux : c'est l'hote qui les lit, et il n'y en a qu'un.
     Les messages destines aux JOUEURS, eux, passent par `messageA` ou
     `annoncer` avec une cle nue -- chacun les recoit dans la sienne.
*/
const { surLaConsole: t } = require('./langues')


/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PERMISSIONS — qui a le droit de quoi
 * ═══════════════════════════════════════════════════════════════════════════
 *  Six roles, une matrice. Rien d'autre dans le serveur ne doit decider d'un
 *  droit : si une commande veut savoir si elle a le droit, elle demande ici.
 *
 *  ⚠️ LE ROLE SE CALCULE, IL NE SE STOCKE PAS SUR LE JOUEUR. L'hote change
 *     quand quelqu'un part ; un role ecrit dans l'objet joueur a l'arrivee
 *     serait faux dix minutes plus tard, et personne ne s'en apercevrait.
 *
 *  ⚠️ LE PROPRIETAIRE EST DESIGNE PAR SON EMPREINTE, PAS PAR SON PSEUDO. Un
 *     pseudo se copie en trois secondes ; l'empreinte demande la cle privee.
 *
 *  ⚠️ UN ANONYME NE MONTE JAMAIS AU-DESSUS DE « hote ». Sans identite
 *     verifiable, il n'y a rien a qui attacher un role durable — et le role le
 *     plus haut atteignable sans preuve doit rester celui que la partie
 *     elle-meme donne.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Du plus fort au plus faible. L'ordre sert aux comparaisons. */
const ROLES = ['proprietaire', 'admin', 'moderateur', 'hote', 'joueur', 'spectateur']

const RANG = new Map(ROLES.map((r, i) => [r, ROLES.length - i]))

/**
 * Ce que chaque role peut faire.
 *
 * ⚠️ LA LISTE EST FERMEE. Une permission inconnue est refusee, jamais
 *    accordee par defaut : une faute de frappe dans un nom de permission doit
 *    fermer la porte, pas l'ouvrir.
 */
const DROITS = {
  proprietaire: [
    'jouer', 'parler', 'commande', 'marquer', 'construire', 'interagir',
    'monde.lire', 'monde.ecrire', 'meteo', 'heure', 'rdv',
    'expulser', 'bannir', 'museler', 'role', 'ressource', 'arreter',
    'spectateur', 'diagnostic', 'joueurs.detail',
  ],
  admin: [
    'jouer', 'parler', 'commande', 'marquer', 'construire', 'interagir',
    'monde.lire', 'monde.ecrire', 'meteo', 'heure', 'rdv',
    'expulser', 'bannir', 'museler', 'ressource',
    'spectateur', 'diagnostic', 'joueurs.detail',
  ],
  moderateur: [
    'jouer', 'parler', 'commande', 'marquer', 'construire', 'interagir',
    'monde.lire', 'meteo', 'heure', 'rdv',
    'expulser', 'museler', 'spectateur', 'diagnostic', 'joueurs.detail',
  ],
  hote: [
    'jouer', 'parler', 'commande', 'marquer', 'construire', 'interagir',
    'monde.lire', 'meteo', 'heure', 'rdv',
    'expulser', 'museler', 'spectateur', 'diagnostic',
  ],
  joueur: [
    'jouer', 'parler', 'commande', 'marquer', 'construire', 'interagir',
    'monde.lire', 'rdv',
  ],
  spectateur: ['parler', 'commande', 'monde.lire', 'spectateur'],
}

const ENSEMBLES = new Map(Object.entries(DROITS).map(([r, l]) => [r, new Set(l)]))

class Permissions {
  /**
   * @param {object} config
   * @param {import('./identite').Identites} identites
   */
  constructor(config, identites) {
    this.config = config
    this.identites = identites
    /*
      ⚠️ PLUSIEURS PROPRIETAIRES SONT PERMIS, ZERO AUSSI. Zero veut dire « la
         partie se gouverne elle-meme » : l'hote a tout ce qu'il faut pour
         jouer entre amis, et rien de plus.
    */
    this.proprietaires = new Set(
      String(config.proprietaires || '')
        .split(/[,\s]+/)
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    )
  }

  /**
   * Le role effectif d'un joueur, maintenant.
   *
   * On prend le plus fort entre ce que son identite porte et ce que la partie
   * lui donne : quelqu'un d'enregistre comme moderateur qui ouvre la partie
   * reste moderateur, il ne redescend pas a « hote ».
   */
  role(joueur) {
    if (!joueur) return 'joueur'
    /*
      ⚠️ LA CONSOLE A TOUS LES DROITS, ET ELLE SEULE PEUT LES AVOIR SANS
         EMPREINTE. Elle ne vient pas du reseau : elle vient de la personne qui
         tient la machine, derriere la cle d'administration. Un joueur ne peut
         pas se declarer console — ce drapeau est pose par le serveur, jamais
         lu dans un paquet.
    */
    if (joueur.console === true) return 'proprietaire'
    if (joueur.spectateur) return 'spectateur'

    let candidat = 'joueur'
    if (joueur.hote) candidat = 'hote'

    const emp = joueur.empreinte
    if (emp) {
      if (this.proprietaires.has(emp.toLowerCase())) return 'proprietaire'
      const p = this.identites ? this.identites.profil(emp) : null
      if (p && p.role && RANG.has(p.role)) {
        if (RANG.get(p.role) > RANG.get(candidat)) candidat = p.role
      }
    }
    return candidat
  }

  /** Vrai si ce joueur a cette permission. */
  peut(joueur, permission) {
    const r = this.role(joueur)
    const ensemble = ENSEMBLES.get(r)
    if (!ensemble) return false
    return ensemble.has(permission)
  }

  /**
   * Le role le plus bas qui detient cette permission.
   *
   * ⚠️ UN REFUS DOIT DIRE A QUI C'EST RESERVE. « Tu n'as pas le droit » laisse
   *    le joueur deviner s'il doit demander, attendre, ou si c'est casse.
   */
  plusBasRolePour(permission) {
    for (let i = ROLES.length - 1; i >= 0; i--) {
      const r = ROLES[i]
      if (ENSEMBLES.get(r)?.has(permission)) return r
    }
    return null
  }

  /** Vrai si `joueur` est au moins aussi haut que `role`. */
  auMoins(joueur, role) {
    const a = RANG.get(this.role(joueur)) || 0
    const b = RANG.get(role) || 0
    return a >= b
  }

  /**
   * Vrai si `acteur` peut agir sur `cible`.
   *
   * ⚠️ ON N'AGIT PAS SUR SON EGAL. Sans ca, deux moderateurs pourraient
   *    s'expulser en boucle, et un admin pourrait bannir le proprietaire.
   */
  domine(acteur, cible) {
    if (!cible) return false
    if (acteur === cible) return false
    const a = RANG.get(this.role(acteur)) || 0
    const b = RANG.get(this.role(cible)) || 0
    return a > b
  }

  /**
   * Pose un role durable. Rend un texte d'erreur, ou `null` si c'est fait.
   *
   * ⚠️ ON NE DONNE PAS UN ROLE QU'ON N'A PAS. Un moderateur qui pourrait
   *    nommer un admin se nommerait admin par personne interposee.
   */
  poserRole(acteur, empreinte, role) {
    if (!this.peut(acteur, 'role')) return t('permissions.tu-n-as-pas-le')
    if (role !== null && !RANG.has(role)) return t('permissions.role-inconnu-au-choix', { v1: ROLES.join(', ') })
    if (role !== null && (RANG.get(role) || 0) >= (RANG.get(this.role(acteur)) || 0)) {
      return t('permissions.tu-ne-peux-pas-donner')
    }
    if (!this.identites || !this.identites.profil(empreinte)) {
      return t('permissions.cette-identite-est-inconnue-du')
    }
    this.identites.poserRole(empreinte, role)
    return null
  }
}

module.exports = { Permissions, ROLES, DROITS }
