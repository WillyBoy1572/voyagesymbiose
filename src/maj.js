'use strict'

const fs = require('node:fs')
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

/**
 * Y a-t-il une version plus récente que la nôtre ?
 *
 * Rend `{ aJour, versionLocale, versionDistante, url, taille }`, ou
 * `{ aJour: null }` quand on n'a pas pu savoir — ce qui n'est pas « à jour ».
 */
async function verifierLanceur(versionLocale) {
  try {
    const r = await fetch(SOURCE, { signal: AbortSignal.timeout(DELAI_MS) })
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

module.exports = { verifierLanceur, versionDuJeu, jeuAChange, comparerVersions, APPID, SOURCE }
