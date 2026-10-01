'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  CONFIGURATION — lue une fois, validee une fois
 * ═══════════════════════════════════════════════════════════════════════════
 *  Les noms de variables suivent ceux que l'hebergement pose deja
 *  (HOST, PORT, HTTP_PORT, MAX_PLAYERS, SNAPSHOT_HZ, TIMEOUT_MS) : le meme
 *  serveur demarre a l'identique sur un panneau Pterodactyl, sur une machine
 *  Linux avec systemd, ou sur le portable de quelqu'un.
 *
 *  ⚠️ UNE VALEUR ABSURDE EST CORRIGEE, PAS ACCEPTEE. `SNAPSHOT_HZ=9999`
 *     saturerait le reseau des quatre joueurs et personne ne comprendrait
 *     pourquoi. On borne, et on le dit dans la console.
 *
 *  ⚠️ CE QUI PUBLIE QUELQUE CHOSE EST ETEINT PAR DEFAUT. Publication de monde,
 *     annonce a l'annuaire : deux reglages qui exposent soit la partie, soit
 *     l'adresse de la machine. Un defaut « allume » serait un defaut que
 *     personne n'a choisi.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const avertissements = []

/**
 * Reglages poses dans un fichier, pour ce que le panneau ne sait pas passer.
 *
 * ⚠️ UN PANNEAU D'HEBERGEMENT NE DONNE QUE LES VARIABLES DECLAREES DANS SON
 *    « egg ». Ajouter une variable demande l'interface d'administration, ou la
 *    base de donnees : un hebergeur qui loue une place n'y a pas acces, et se
 *    retrouverait sans moyen d'allumer le cycle jour/nuit ou l'annuaire. Un
 *    fichier qu'il peut ecrire par le gestionnaire de fichiers suffit.
 *
 * ⚠️ LES VRAIES VARIABLES D'ENVIRONNEMENT GAGNENT TOUJOURS. Le fichier est un
 *    DEFAUT, pas une surcharge : sinon un fichier oublie contredirait en silence
 *    ce que le panneau affiche, et personne ne comprendrait pourquoi.
 *
 * ⚠️ ON NE LIT QUE DES LIGNES `CLE=valeur`. Pas d'interpolation, pas de
 *    commandes, pas de guillemets a interpreter : ce fichier est de la
 *    configuration, pas un script.
 */
const DEPUIS_FICHIER = (() => {
  const table = {}
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const dossier = (process.env.DONNEES ?? './donnees').trim() || './donnees'
    const chemin = path.join(dossier, 'reglages.env')
    const brut = fs.readFileSync(chemin, 'utf8')
    for (const ligne of brut.split(/\r?\n/)) {
      const propre = ligne.trim()
      if (!propre || propre.startsWith('#')) continue
      const m = propre.match(/^([A-Z0-9_]{1,48})\s*=\s*(.*)$/)
      if (!m) continue
      table[m[1]] = m[2].replace(/^["']|["']$/g, '').trim().slice(0, 512)
    }
    if (Object.keys(table).length) {
      avertissements.push(`${Object.keys(table).length} reglage(s) lu(s) dans ${chemin}.`)
    }
  } catch {
    /* pas de fichier : c'est le cas normal */
  }
  return table
})()

/** La valeur brute d'un reglage : l'environnement d'abord, le fichier ensuite. */
function brute(nom) {
  const v = process.env[nom]
  if (v !== undefined && v !== '') return v
  return DEPUIS_FICHIER[nom]
}

function entier(nom, defaut, min, max) {
  const brut = brute(nom)
  if (brut === undefined || brut === '') return defaut

  const v = Number.parseInt(brut, 10)
  if (!Number.isFinite(v)) {
    avertissements.push(`${nom} = « ${brut} » n'est pas un nombre, on garde ${defaut}.`)
    return defaut
  }
  if (v < min || v > max) {
    const borne = Math.min(Math.max(v, min), max)
    avertissements.push(`${nom} = ${v} est hors des bornes [${min}, ${max}], ramene a ${borne}.`)
    return borne
  }
  return v
}

function texte(nom, defaut, maxLongueur) {
  const v = (brute(nom) ?? '').trim()
  if (!v) return defaut
  return v.slice(0, maxLongueur)
}

/**
 * Un drapeau. Accepte `1`, `oui`, `true`, `on` — et rien d'autre ne l'allume.
 *
 * ⚠️ TOUT CE QUI N'EST PAS EXPLICITEMENT « OUI » VAUT NON. `ANNUAIRE=peut-etre`
 *    ne doit pas publier l'adresse de la machine.
 */
function drapeau(nom, defaut = false) {
  const v = (brute(nom) ?? '').trim().toLowerCase()
  if (!v) return defaut
  return ['1', 'oui', 'yes', 'true', 'on', 'vrai'].includes(v)
}

const config = {
  /** 0.0.0.0 : on ecoute partout. L'hebergeur, lui, ne publie qu'un port. */
  hote: texte('HOST', '0.0.0.0', 64),

  /** Le jeu, en UDP. */
  port: entier('PORT', 7777, 1, 65535),

  /**
   * Le monde et le navigateur de serveurs, en TCP.
   * Par defaut le port du jeu + 1, comme le veut l'usage.
   */
  portHttp: entier('HTTP_PORT', 0, 0, 65535) || entier('PORT', 7777, 1, 65535) + 1,

  nom: texte('SERVER_NAME', 'Serveur Voyage', 60),

  /**
   * ⚠️ QUATRE JOUEURS, PAS QUARANTE. Le jeu est pense pour la solitude ; la
   *    synchronisation d'etat qu'on fait ici tient une petite equipe, pas une
   *    foule. On laisse monter jusqu'a 16 pour les curieux, pas au-dela.
   */
  maxJoueurs: entier('MAX_PLAYERS', 4, 1, 16),

  /** Instantanes par seconde. 20 est le bon compromis fluidite / bande passante. */
  hz: entier('SNAPSHOT_HZ', 20, 5, 60),

  /** Sans nouvelles pendant ce delai, un joueur est considere parti. */
  delaiMs: entier('TIMEOUT_MS', 10_000, 2_000, 60_000),

  /** Vide = serveur ouvert. Sinon il faut le donner au moment de se connecter. */
  motDePasse: texte('SERVER_PASSWORD', '', 128),

  /** Ou vivent le monde publie et les positions retenues. */
  dossierDonnees: texte('DONNEES', './donnees', 256),

  /** Ou vivent les ressources ajoutees par l'hebergeur. */
  dossierRessources: texte('RESSOURCES', './ressources', 256),

  /*
    ⚠️ VIDE = PUBLICATION FERMEE, ET C'EST VOULU. Il n'y a pas de valeur par
       defaut : sans ce mot de passe, personne ne peut remplacer le monde de
       la partie. Un defaut serait un defaut connu de tous.
  */
  motDePasseMonde: texte('MONDE_MOTDEPASSE', '', 128),

  // ── Identite et roles ───────────────────────────────────────────────────

  /**
   * Empreintes d'identite qui recoivent tous les droits, separees par des
   * virgules.
   *
   * ⚠️ C'EST UNE EMPREINTE, PAS UN PSEUDO. Un pseudo se copie en trois
   *    secondes ; l'empreinte demande la cle privee correspondante. Le lanceur
   *    l'affiche dans ses reglages.
   */
  proprietaires: texte('PROPRIETAIRES', '', 1024),

  /**
   * Exiger une identite signee pour entrer.
   *
   * ⚠️ ETEINT PAR DEFAUT : l'allumer ferme la porte a quiconque n'a pas le
   *    lanceur, et c'est un choix d'hebergeur, pas un defaut.
   */
  identiteObligatoire: drapeau('IDENTITE_OBLIGATOIRE', false),

  // ── Temps et monde ──────────────────────────────────────────────────────

  /**
   * Minutes de jeu par minute reelle. 0 = horloge figee, l'hote decide.
   *
   * 1 donne un cycle de 24 h en 24 h reelles ; 20 donne une journee en
   * 1 h 12 min, ce qui est l'ordre de grandeur habituel d'un jeu de survie.
   */
  cycleMinutes: entier('CYCLE_MINUTES', 0, 0, 240),

  /** Laisser le serveur faire evoluer la meteo tout seul. */
  meteoAuto: drapeau('METEO_AUTO', false),

  // ── Annuaire public ─────────────────────────────────────────────────────

  /*
    ⚠️ S'ANNONCER PUBLIE L'ADRESSE DE LA MACHINE. Pour un serveur heberge a la
       maison, c'est rendre publique son adresse domestique. On ne le fait
       jamais a la place du proprietaire.
  */
  annuaire: drapeau('ANNUAIRE', false),
  annuaireUrl: texte('ANNUAIRE_URL', 'https://caretakermp.symbioseheritage.ca/api/annuaire', 256),
  annuaireCle: texte('ANNUAIRE_CLE', '', 128),
  /** Vide = l'annuaire lit l'adresse source, la seule qui soit vraie. */
  annuaireAdresse: texte('ANNUAIRE_ADRESSE', '', 128),
  pays: texte('PAYS', '', 8),

  /*
    La cle qui ouvre les routes `/admin/...`.

    ATTENTION : ELLE PASSE PAR ICI, PAS PAR `process.env` EN DIRECT. `http.js`
    la lisait lui-meme, et sautait donc le repli par fichier : posee dans
    `donnees/reglages.env` -- le seul endroit ou un locataire de panneau peut
    l'ecrire -- elle n'etait jamais vue, et `/admin/etat` repondait 404 sans que
    rien ne dise pourquoi. Un reglage doit avoir UNE source.
  */
  cleAdmin: texte('ADMIN_CLE', '', 128),

  /** Version du protocole : un client plus vieux est refuse proprement. */
  protocole: 2,
  /**
   * Le plus vieux protocole encore accepte.
   *
   * ⚠️ UN CLIENT PLUS ANCIEN DOIT POUVOIR ENTRER. Monter le protocole sans
   *    marge rejetterait tout le monde a chaque mise a jour du serveur, y
   *    compris les joueurs qui n'ont pas encore relance leur lanceur.
   */
  protocoleMinimum: 1,
  version: require('../package.json').version,

  avertissements,
  /** Ce que le fichier de reglages a fourni, pour le diagnostic. */
  reglagesDeFichier: Object.keys(DEPUIS_FICHIER),
}

module.exports = config
