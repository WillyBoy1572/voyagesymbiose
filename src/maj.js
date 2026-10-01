'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const https = require('node:https')
const os = require('node:os')
const path = require('node:path')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  MISES À JOUR — la nôtre, et celle du jeu
 * ═══════════════════════════════════════════════════════════════════════════
 *  Deux questions qui ne se posent jamais à temps :
 *
 *    « Ma version est-elle encore la bonne ? »  Sans vérification, quelqu'un
 *    installe une version, n'y revient jamais, se fait refuser par les serveurs
 *    six mois plus tard, et conclut que le mod est cassé.
 *
 *    « Le jeu a-t-il changé sous nos pieds ? »  Steam met à jour en silence. Une
 *    classe renommée et le mod se tait, sans la moindre erreur — c'est le pire
 *    des échecs, celui qui ressemble à un bug de chez le joueur.
 *
 *  ⚠️ ON NE TÉLÉCHARGE RIEN TOUT SEUL, ET ON N'INSTALLE RIEN. On regarde, on
 *     dit, et le joueur décide. Un lanceur qui remplace son propre exécutable
 *     pendant qu'une partie tourne est une mauvaise idée ; un lanceur qui
 *     installe sans demander en est une pire.
 *
 *  ⚠️ HORS LIGNE N'EST PAS UNE PANNE. Pas de réseau, pas de vérification, et le
 *     lanceur démarre exactement pareil.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** L'identifiant Steam du jeu. Le même que dans `jeu.js`. */
const APPID = 1783560

/** Où le site publie ce qu'il distribue. */
const SOURCE = 'https://caretakermp.symbioseheritage.ca/api/fichiers'

/** Au-delà, on laisse tomber : le lanceur ne doit pas attendre le réseau. */
const DELAI_MS = 6000

/**
 * Compare deux versions « a.b.c ».
 *
 * ⚠️ PAS DE COMPARAISON DE CHAÎNES. « 0.10.0 » est plus récent que « 0.9.0 »,
 *    mais plus petit en ordre alphabétique : la comparaison naïve dirait au
 *    joueur qu'il est à jour pendant des mois.
 */
function comparerVersions(a, b) {
  const decouper = (v) =>
    String(v || '0')
      .split(/[.\-+]/)
      .map((x) => Number.parseInt(x, 10))
      .map((x) => (Number.isFinite(x) ? x : 0))

  const ga = decouper(a)
  const gb = decouper(b)
  const n = Math.max(ga.length, gb.length)
  for (let i = 0; i < n; i++) {
    const x = ga[i] ?? 0
    const y = gb[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

/** La base d'ou on accepte de telecharger. Rien d'autre.
 *
 * ⚠️ ON NE SUIT PAS L'URL DONNEE PAR LA REPONSE. Le manifeste dit un nom de
 *    fichier ; c'est NOUS qui construisons l'adresse, a partir d'une base ecrite
 *    en dur. Sinon il suffirait de servir un manifeste pointant ailleurs pour
 *    faire telecharger et EXECUTER n'importe quoi sur la machine du joueur.
 */
const BASE_TELECHARGEMENT = 'https://caretakermp.symbioseheritage.ca/telecharger/'

/** Un nom de fichier qu'on accepte de poser sur le disque. */
const NOM_INSTALLEUR = /^[A-Za-z0-9._-]{1,120}\.exe$/

/**
 * Y a-t-il une version plus récente que la nôtre ?
 *
 * Rend `{ aJour, versionLocale, versionDistante, url, taille }`, ou
 * `{ aJour: null }` quand on n'a pas pu savoir — ce qui n'est pas « à jour ».
 */
async function verifierLanceur(versionLocale) {
  try {
    const r = await fetch(SOURCE, { signal: AbortSignal.timeout(DELAI_MS), redirect: 'error' })
    if (!r.ok) return { aJour: null, raison: `HTTP ${r.status}` }
    const liste = await r.json()
    if (!Array.isArray(liste)) return { aJour: null, raison: 'réponse illisible' }

    const principal = liste.find((f) => f && f.principal) ?? liste[0]
    if (!principal || typeof principal.version !== 'string') {
      return { aJour: null, raison: 'aucune version publiée' }
    }

    const ecart = comparerVersions(principal.version, versionLocale)
    return {
      aJour: ecart <= 0,
      versionLocale,
      versionDistante: principal.version,
      nom: principal.nom ?? null,
      taille: principal.taille ?? null,
      sha256: principal.sha256 ?? null,
    }
  } catch (e) {
    /*
      ⚠️ ON NE DIT PAS « À JOUR » QUAND ON N'A PAS PU VÉRIFIER. `null` veut dire
         « on ne sait pas », et l'interface l'affiche comme tel. Afficher un
         rassurant « à jour » après un échec réseau est exactement le mensonge
         qui laisse les gens sur une vieille version.
    */
    return { aJour: null, raison: e.name === 'TimeoutError' ? 'délai dépassé' : 'injoignable' }
  }
}

/**
 * Le numéro de version du jeu, lu dans le manifeste de Steam.
 *
 * ⚠️ C'EST `buildid` QUI COMPTE, PAS LA DATE DU DOSSIER. Steam remplace des
 *    fichiers sans toucher à la date du dossier parent, et un correctif
 *    silencieux peut renommer une classe que le mod cherche par son nom.
 *
 * ⚠️ ON REMONTE DEPUIS LE DOSSIER DU JEU, PAS DEPUIS LE REGISTRE. Le manifeste
 *    vit dans `steamapps/` de la bibliothèque qui contient le jeu — qui n'est
 *    pas forcément celle que le registre nomme.
 */
function versionDuJeu(dossierJeu) {
  if (!dossierJeu) return null
  try {
    // .../steamapps/common/<Jeu>  →  .../steamapps
    const steamapps = path.resolve(dossierJeu, '..', '..')
    const manifeste = path.join(steamapps, `appmanifest_${APPID}.acf`)
    if (!fs.existsSync(manifeste)) return null

    const texte = fs.readFileSync(manifeste, 'utf8')
    const build = texte.match(/"buildid"\s+"(\d+)"/)
    const maj = texte.match(/"LastUpdated"\s+"(\d+)"/)
    const nom = texte.match(/"name"\s+"([^"]+)"/)

    return {
      build: build ? build[1] : null,
      misAJourLe: maj ? Number.parseInt(maj[1], 10) * 1000 : null,
      nom: nom ? nom[1] : null,
    }
  } catch {
    return null
  }
}

/**
 * Le jeu a-t-il changé depuis la dernière fois qu'on l'a vu ?
 *
 * ⚠️ LA PREMIÈRE FOIS N'EST PAS UN CHANGEMENT. Sans ce cas, tout nouveau joueur
 *    recevrait un avertissement inquiétant à sa toute première ouverture.
 */
function jeuAChange(actuel, connu) {
  if (!actuel || !actuel.build) return { change: false, connu: false }
  if (!connu || !connu.build) return { change: false, connu: false, build: actuel.build }
  return {
    change: actuel.build !== connu.build,
    connu: true,
    build: actuel.build,
    buildPrecedent: connu.build,
  }
}

/**
 * Telecharge l'installeur annonce et verifie son empreinte.
 *
 * ⚠️ ON VERIFIE AVANT DE RENDRE LE CHEMIN, PAS APRES L'AVOIR LANCE. Ce fichier
 *    va etre EXECUTE : une coupure de reseau, un cache d'operateur ou un miroir
 *    hostile donnent le meme symptome -- un fichier qui n'est pas le notre. Sans
 *    empreinte publiee, on refuse purement et simplement.
 *
 * ⚠️ ON ECRIT DANS UN FICHIER TEMPORAIRE PUIS ON RENOMME. Un telechargement
 *    interrompu laisserait sinon un .exe tronque que quelqu'un finirait par
 *    double-cliquer.
 */
async function telechargerLanceur(info, surAvancement = () => {}) {
  if (!info || typeof info.nom !== 'string' || !NOM_INSTALLEUR.test(info.nom)) {
    throw Object.assign(new Error('nom de fichier refus\u00e9'), { cle: 'err.majNom' })
  }
  if (typeof info.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(info.sha256)) {
    throw Object.assign(new Error('aucune empreinte publi\u00e9e'), { cle: 'err.majSansEmpreinte' })
  }

  const dossier = path.join(os.tmpdir(), 'voyage-lanceur', 'maj')
  fs.mkdirSync(dossier, { recursive: true })
  const cible = path.join(dossier, info.nom)
  const abri = cible + '.part'
  fs.rmSync(abri, { force: true })

  const url = BASE_TELECHARGEMENT + encodeURIComponent(info.nom)
  const empreinte = crypto.createHash('sha256')
  let recu = 0

  await new Promise((resolve, rejeter) => {
    const requete = https.get(url, { timeout: 120_000 }, (reponse) => {
      /*
        ⚠️ AUCUNE REDIRECTION. On sait ou est le fichier ; suivre un `302`
           reviendrait a laisser le serveur choisir ce qu'on execute.
      */
      if (reponse.statusCode !== 200) {
        reponse.resume()
        rejeter(new Error(`HTTP ${reponse.statusCode}`))
        return
      }
      const total = Number.parseInt(reponse.headers['content-length'] || '0', 10) || info.taille || 0
      const sortie = fs.createWriteStream(abri)
      reponse.on('data', (m) => {
        empreinte.update(m)
        recu += m.length
        surAvancement(recu, total)
      })
      reponse.pipe(sortie)
      sortie.on('finish', () => sortie.close(resolve))
      sortie.on('error', rejeter)
    })
    requete.on('timeout', () => requete.destroy(new Error('d\u00e9lai d\u00e9pass\u00e9')))
    requete.on('error', rejeter)
  })

  const vu = empreinte.digest('hex')
  if (vu.toLowerCase() !== info.sha256.toLowerCase()) {
    fs.rmSync(abri, { force: true })
    throw Object.assign(new Error('empreinte diff\u00e9rente'), { cle: 'err.majEmpreinte' })
  }

  fs.rmSync(cible, { force: true })
  fs.renameSync(abri, cible)
  return { chemin: cible, octets: recu, sha256: vu }
}

module.exports = {
  telechargerLanceur,
  BASE_TELECHARGEMENT, verifierLanceur, versionDuJeu, jeuAChange, comparerVersions, APPID, SOURCE }
