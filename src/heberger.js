'use strict'

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn } = require('node:child_process')
const sauvegardes = require('./sauvegardes')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  HÉBERGER DEPUIS CHEZ SOI
 * ═══════════════════════════════════════════════════════════════════════════
 *  Le lanceur embarque le serveur Voyage. Un bouton le démarre sur la machine
 *  du joueur, avec SA sauvegarde publiée dedans, et ses amis s'y branchent.
 *  Rien à installer, rien à louer, rien à téléverser.
 *
 *  ⚠️ C'EST LA SEULE FAÇON D'HÉBERGER AVEC SA PROPRE PARTIE. Sur un serveur
 *     loué, publier un monde demande le mot de passe de publication, que seul
 *     celui qui tient l'hébergement possède. Ici, l'archive est écrite
 *     directement dans le dossier du serveur, avant qu'il démarre : pas de
 *     réseau, pas de mot de passe, pas de téléversement.
 *
 *  ⚠️ ON NE DEMANDE PAS D'INSTALLER NODE. Electron EST Node : lancé avec
 *     `ELECTRON_RUN_AS_NODE=1`, son propre exécutable exécute `server.js`.
 *
 *  ⚠️ ON N'ARRÊTE PAS LE SERVEUR AVEC `kill`. Sous Windows il est terminé
 *     d'autorité, sans qu'aucun gestionnaire ne s'exécute : les positions, les
 *     identités et le coffre perdent leur dernière minute. On lui écrit `stop`
 *     sur son entrée standard, il s'arrête proprement, et le `kill` ne sert que
 *     de dernier recours.
 *
 *  ⚠️ LES SECRETS SONT TIRÉS AU HASARD ET GARDÉS LOCALEMENT. Clé
 *     d'administration et mot de passe de publication sont fabriqués une fois,
 *     écrits dans le dossier de l'application, et ne sont jamais affichés ni
 *     passés en ligne de commande.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** On garde de quoi comprendre, pas tout l'historique. */
const LIGNES_GARDEES = 400

/** Au-delà, on considère que le serveur n'a pas démarré. */
const DELAI_DEMARRAGE_MS = 20_000

/**
 * Le point de rendez-vous par défaut.
 *
 * ⚠️ C'EST UN SERVEUR PUBLIC, PAS UN SERVICE À PART. Nos serveurs publics ont
 *    déjà une adresse joignable de partout : l'un d'eux tient le point de
 *    rendez-vous, et c'est tout ce qu'il faut pour que les hôtes derrière une
 *    box se fassent trouver.
 */
/*
  ⚠️ CE POINT DE RENDEZ-VOUS N'EST PAS UN SERVEUR DE JEU, ET C'EST TOUT
     L'INTERET. Les serveurs publics sont joints par un tunnel qui masque
     l'adresse de leurs visiteurs : un rendez-vous tenu par l'un d'eux voit
     tout le monde arriver de la meme adresse privee et ne peut rien faire.
     Celui-ci tourne sur le VPS frontal lui-meme, sur un port hors de la plage
     redirigee : il lit la vraie adresse. Verifie le 2026-10-01 : un client
     exterieur a joint une partie derriere une box, sans redirection de port.
*/
const RENDEZVOUS_PAR_DEFAUT = '144.217.162.237:29999'

let processus = null
let lignes = []
let ecouteur = null
let racineDonnees = null
let reglagesCourants = null
let pret = false

/** Appelée à chaque nouvelle ligne, pour que l'interface suive en direct. */
function surLigne(f) {
  ecouteur = f
}

function noter(texte) {
  const heure = new Date().toTimeString().slice(0, 8)
  const ligne = typeof texte === 'string' ? `${heure} ${texte}` : { heure, ...texte }
  lignes.push(ligne)
  if (lignes.length > LIGNES_GARDEES) lignes = lignes.slice(-LIGNES_GARDEES)
  if (ecouteur) ecouteur(ligne)
}

/**
 * Pose le dossier où vivent les données du serveur hébergé.
 *
 * ⚠️ LE MODULE NE DEVINE PAS OÙ SONT LES DONNÉES. `app.getPath` n'existe que
 *    dans le processus principal d'Electron ; un module qui l'appellerait ne
 *    serait plus testable hors d'Electron.
 */
function poserContexte({ dossier }) {
  racineDonnees = dossier || null
}

function dossierServeur() {
  if (!racineDonnees) throw Object.assign(new Error('Dossier de données inconnu.'), { cle: 'err.donnees' })
  return path.join(racineDonnees, 'heberge')
}

/**
 * Le chemin de `serveur/src/server.js`, en développement comme installé.
 *
 * ⚠️ IL DOIT SORTIR DE L'ARCHIVE asar. Un fichier resté dans l'asar ne peut pas
 *    être lancé comme programme : `serveur/` est empaqueté en `unpacked`, et on
 *    corrige le chemin ici.
 */
function cheminServeur() {
  const dansAsar = path.join(__dirname, '..', 'serveur', 'src', 'server.js')
  const dehors = dansAsar.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
  if (fs.existsSync(dehors)) return dehors
  if (fs.existsSync(dansAsar)) return dansAsar
  throw Object.assign(new Error('Le serveur embarqué est introuvable.'), { cle: 'err.serveurIntrouvable' })
}

// ── Secrets ───────────────────────────────────────────────────────────────

function cheminSecrets() {
  return path.join(dossierServeur(), 'secrets.json')
}

/**
 * Les deux secrets du serveur hébergé, fabriqués une fois pour toutes.
 *
 * ⚠️ ON NE LES REFABRIQUE PAS À CHAQUE DÉMARRAGE. La clé d'administration
 *    change sinon à chaque session, et le mot de passe de publication avec —
 *    or c'est lui qui permet de republier sa partie plus tard.
 */
function secrets() {
  try {
    const d = JSON.parse(fs.readFileSync(cheminSecrets(), 'utf8'))
    if (d && typeof d.admin === 'string' && typeof d.monde === 'string') return d
  } catch {
    /* premier démarrage */
  }
  const d = {
    admin: crypto.randomBytes(16).toString('hex'),
    monde: crypto.randomBytes(16).toString('hex'),
  }
  fs.mkdirSync(path.dirname(cheminSecrets()), { recursive: true })
  fs.writeFileSync(cheminSecrets(), JSON.stringify(d, null, 1), { encoding: 'utf8', mode: 0o600 })
  return d
}

// ── La partie de l'hôte, posée dans le serveur ────────────────────────────

/**
 * Écrit la sauvegarde de l'hôte dans le dossier du serveur, comme si elle y
 * avait été publiée.
 *
 * ⚠️ ON ÉCRIT LES DEUX FICHIERS, PAS SEULEMENT L'ARCHIVE. Le serveur lit
 *    `monde.json` au démarrage et jette une fiche sans archive ; une archive
 *    sans fiche, elle, n'est jamais proposée aux joueurs. Il faut les deux, et
 *    l'empreinte doit être celle de l'archive — pas une valeur reprise d'avant.
 *
 * ⚠️ ON LE FAIT AVANT DE DÉMARRER. Le serveur lit son monde une fois, à la
 *    construction : l'écrire pendant qu'il tourne ne changerait rien jusqu'au
 *    prochain redémarrage.
 */
async function poserLeMonde({ dossierSauvegardes, nom, par }) {
  const source = sauvegardes.dossierSauvegardes(dossierSauvegardes)
  if (!source) throw Object.assign(new Error('Dossier de sauvegardes introuvable.'), { cle: 'err.sauvegardes' })

  const fichiers = sauvegardes.lister(source)
  if (fichiers.length === 0) {
    throw Object.assign(new Error('Aucune sauvegarde à partager.'), { cle: 'err.aucuneSauvegarde' })
  }

  const donnees = path.join(dossierServeur(), 'donnees')
  fs.mkdirSync(donnees, { recursive: true })

  /*
    ⚠️ LE FICHIER TEMPORAIRE DOIT FINIR PAR `.zip`. `Compress-Archive` refuse
       toute autre extension — « monde.zip.tmp » lui suffisait pour échouer, et
       l'hébergement ne démarrait pas du tout. On écrit donc à côté sous un nom
       qui finit bien par `.zip`, puis on renomme.
  */
  const archive = path.join(donnees, 'monde-en-cours.zip')
  try {
    fs.rmSync(archive, { force: true })
  } catch {
    /* rien à retirer */
  }
  await sauvegardes.compresser(source, archive)

  const octets = fs.readFileSync(archive)
  const empreinte = crypto.createHash('sha256').update(octets).digest('hex')
  fs.renameSync(archive, path.join(donnees, 'monde.zip'))

  const fiche = {
    nom: String(nom || 'Ma partie').slice(0, 60),
    etiquette: '',
    note: '',
    publiePar: String(par || 'hôte').slice(0, 24),
    fichiers: fichiers.length,
    empreinte,
    taille: octets.length,
    date: new Date().toISOString(),
  }
  const abri = path.join(donnees, 'monde.json.tmp')
  fs.writeFileSync(abri, JSON.stringify(fiche, null, 1), 'utf8')
  fs.renameSync(abri, path.join(donnees, 'monde.json'))

  noter({ cle: 'heb.mondePose', valeurs: { fichiers: fichiers.length, ko: Math.round(octets.length / 1024) } })
  return fiche
}

// ── Démarrer et arrêter ───────────────────────────────────────────────────

function actif() {
  return Boolean(processus) && processus.exitCode === null
}

function etat() {
  return {
    actif: actif(),
    pret,
    reglages: reglagesCourants
      ? {
          nom: reglagesCourants.nom,
          port: reglagesCourants.port,
          portHttp: reglagesCourants.port + 1,
          maxJoueurs: reglagesCourants.maxJoueurs,
          protege: Boolean(reglagesCourants.motDePasse),
          public: Boolean(reglagesCourants.public),
          percage: Boolean(reglagesCourants.percage),
          monde: reglagesCourants.monde ?? null,
        }
      : null,
    lignes,
  }
}

/** De quoi parler à `/admin/…` de notre propre serveur. */
function adresseAdmin() {
  if (!reglagesCourants) return null
  return {
    base: `http://127.0.0.1:${reglagesCourants.port + 1}`,
    cle: secrets().admin,
  }
}

/**
 * Démarre le serveur.
 *
 * `empreinte` est l'identité de l'hôte : elle le rend **propriétaire** de son
 * propre serveur, donc capable d'expulser et de bannir sans rien configurer.
 */
async function demarrer(reglages) {
  if (actif()) await arreter()

  const dossier = dossierServeur()
  fs.mkdirSync(path.join(dossier, 'donnees'), { recursive: true })

  const nom = String(reglages.nom || 'Ma partie').slice(0, 60)
  const port = Math.min(Math.max(Number.parseInt(reglages.port, 10) || 7777, 1024), 65000)
  const maxJoueurs = Math.min(Math.max(Number.parseInt(reglages.maxJoueurs, 10) || 4, 1), 16)
  const motDePasse = String(reglages.motDePasse || '').slice(0, 128)

  lignes = []
  pret = false

  let monde = null
  if (reglages.partagerLaPartie !== false) {
    monde = await poserLeMonde({
      dossierSauvegardes: reglages.dossierSauvegardes,
      nom,
      par: reglages.pseudo,
    })
  }

  const s = secrets()

  /*
    ⚠️ LES SECRETS PASSENT PAR L'ENVIRONNEMENT, PAS PAR LA LIGNE DE COMMANDE.
       Une ligne de commande se lit depuis n'importe quel autre programme de la
       machine ; l'environnement d'un processus, non.
  */
  const environnement = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    HOST: '0.0.0.0',
    PORT: String(port),
    HTTP_PORT: String(port + 1),
    SERVER_NAME: nom,
    MAX_PLAYERS: String(maxJoueurs),
    SERVER_PASSWORD: motDePasse,
    DONNEES: path.join(dossier, 'donnees'),
    RESSOURCES: path.join(dossier, 'ressources'),
    MONDE_MOTDEPASSE: s.monde,
    ADMIN_CLE: s.admin,
    ANNUAIRE: reglages.public ? '1' : '0',

    /*
      ⚠️ LE PERCAGE EST CE QUI EVITE D'OUVRIR UN PORT SUR LA BOX. Le serveur
         s'annonce a un point de rendez-vous public depuis SA PROPRE prise UDP,
         et garde ainsi le chemin ouvert. Ça ne marche pas partout — un NAT dit
         « symetrique » resiste — et le serveur le dit lui-meme dans son rapport
         plutot que de laisser l'hote accuser ses amis.
    */
    /*
      ⚠️ LA CONSOLE DU SERVEUR PARLE LA LANGUE DU LANCEUR. C'est l'hôte qui la
         lit, et c'est lui qui a choisi. Les JOUEURS, eux, reçoivent leurs
         messages dans la leur — chacun l'annonce en arrivant.
    */
    LANGUE: String(reglages.langue || 'fr').slice(0, 2),
    PERCAGE: reglages.percage === false ? '0' : '1',
    RENDEZVOUS_ADRESSE: String(reglages.rendezvous || RENDEZVOUS_PAR_DEFAUT).slice(0, 128),
    PAYS: String(reglages.pays || '').slice(0, 8),
    CYCLE_MINUTES: String(Math.min(Math.max(Number.parseInt(reglages.cycleMinutes, 10) || 0, 0), 240)),
  }

  /*
    ⚠️ L'HÔTE EST PROPRIÉTAIRE DE SON PROPRE SERVEUR. Sans ça il serait un
       simple « hôte » : il pourrait expulser, mais ni bannir ni donner un rôle
       sur une machine qui est la sienne.
  */
  if (reglages.empreinte) environnement.PROPRIETAIRES = String(reglages.empreinte).slice(0, 64)

  reglagesCourants = {
    nom,
    port,
    maxJoueurs,
    motDePasse,
    public: Boolean(reglages.public),
    percage: reglages.percage !== false,
    monde: monde?.nom ?? null,
  }

  noter({ cle: 'heb.demarrage', valeurs: { nom, port } })

  processus = spawn(process.execPath, [cheminServeur()], {
    env: environnement,
    cwd: dossier,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  let reste = ''
  const avaler = (bout) => {
    reste += bout
    const morceaux = reste.split(/\r?\n/)
    reste = morceaux.pop() ?? ''
    for (const m of morceaux) {
      if (!m.trim()) continue
      if (m.includes('server_listening')) {
        pret = true
        noter({ cle: 'heb.enLigne', valeurs: { port } })
        continue
      }
      // Les lignes du serveur sont déjà écrites : on retire juste son horodatage.
      noter(m.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, ''))
    }
  }
  processus.stdout.setEncoding('utf8')
  processus.stderr.setEncoding('utf8')
  processus.stdout.on('data', avaler)
  processus.stderr.on('data', avaler)

  processus.on('error', (e) => noter({ cle: 'heb.pasDemarre', valeurs: { raison: e.message } }))
  processus.on('exit', (code) => {
    noter(code === 0 || code === null ? { cle: 'heb.arrete' } : { cle: 'heb.arreteCode', valeurs: { code } })
    processus = null
    pret = false
  })

  // On attend le mot que le serveur dit quand il écoute vraiment.
  const fin = Date.now() + DELAI_DEMARRAGE_MS
  while (Date.now() < fin && !pret && actif()) {
    await new Promise((r) => setTimeout(r, 100))
  }
  if (!pret) {
    await arreter()
    throw Object.assign(new Error('Le serveur n’a pas démarré.'), { cle: 'err.serveurPasDemarre' })
  }

  return etat()
}

/**
 * Arrête le serveur, proprement.
 *
 * ⚠️ `stop` SUR L'ENTRÉE STANDARD, PAS `kill`. Sous Windows, `kill` termine le
 *    processus d'autorité : aucun gestionnaire ne s'exécute, et la dernière
 *    minute de positions, d'identités et de coffre est perdue. Le `kill` ne
 *    reste que si le serveur ne répond pas.
 */
function arreter() {
  const condamne = processus
  processus = null
  pret = false
  reglagesCourants = null
  if (!condamne) return Promise.resolve(etat())

  try {
    condamne.stdin.write('stop\n')
  } catch {
    /* il est peut-être déjà mort */
  }

  return new Promise((resolve) => {
    const abandon = setTimeout(() => {
      if (condamne.exitCode === null) {
        noter({ cle: 'heb.force' })
        try {
          condamne.kill()
        } catch {
          /* déjà parti */
        }
      }
      resolve(etat())
    }, 4000)

    condamne.on('exit', () => {
      clearTimeout(abandon)
      resolve(etat())
    })
  })
}

/** Au plus tard à la fermeture du lanceur, on ne laisse pas de serveur derrière. */
function nettoyer() {
  if (!processus) return
  try {
    processus.stdin.write('stop\n')
  } catch {
    /* rien à faire */
  }
  try {
    processus.kill()
  } catch {
    /* rien à faire */
  }
  processus = null
}

/**
 * Envoie une commande à son propre serveur.
 *
 * ⚠️ ON PASSE PAR L'ENTRÉE STANDARD, PAS PAR HTTP. C'est le même chemin que la
 *    console d'un panneau d'hébergement, ça ne demande aucun réseau, et ça
 *    marche même si le port TCP est occupé par autre chose.
 */
function commande(texte) {
  if (!actif()) return false
  const propre = String(texte || '').replace(/[\r\n]+/g, ' ').trim()
  if (!propre) return false
  if (/^(stop|arret|arrêt|quit|exit)$/i.test(propre)) return false
  try {
    processus.stdin.write(propre + '\n')
    return true
  } catch {
    return false
  }
}

module.exports = {
  RENDEZVOUS_PAR_DEFAUT,
  poserContexte,
  demarrer,
  arreter,
  commande,
  etat,
  actif,
  surLigne,
  adresseAdmin,
  nettoyer,
  dossierServeur,
  poserLeMonde,
}
