'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LES MODULES QUI N'AVAIENT AUCUN BANC
 * ═══════════════════════════════════════════════════════════════════════════
 *      node essais/modules.js
 *
 *  `administration.js`, `serveurs.js` et `ue4ss.js` tenaient des clés, des
 *  adresses et une archive, sans qu'une seule ligne ne les éprouve. Ce banc ne
 *  les couvre pas entièrement — il couvre ce qui, en cassant, casserait en
 *  silence.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const administration = require('../src/administration')
const serveurs = require('../src/serveurs')
const ue4ss = require('../src/ue4ss')
const maj = require('../src/maj')

let echecs = 0
let essais = 0

function ok(c, libelle, detail = '') {
  essais++
  console.log(c ? `  ✔ ${libelle}` : `  ✘ ${libelle}${detail ? ` — ${detail}` : ''}`)
  if (!c) echecs++
}

function titre(t) {
  console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(2, 54 - t.length)))
}

const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-modules-'))

async function principal() {
  titre('Les clés d’administration ne sortent pas')

  administration.poserContexte({ dossier })
  administration.poserCle('1.2.3.4', 7777, 'ma-cle-tres-secrete')

  const liste = administration.serveursConfigures()
  ok(liste.length === 1, 'un serveur est configuré')
  ok(liste[0].hote === '1.2.3.4' && liste[0].port === 7777, 'avec son adresse', JSON.stringify(liste[0]))
  /*
    ⚠️ LA LISTE SERT À REMPLIR UNE PAGE WEB. Si la clé y était, elle vivrait dans
       le processus de rendu, dans la mémoire du navigateur, et dans tout ce qui
       en garde une copie.
  */
  ok(
    !JSON.stringify(liste).includes('ma-cle-tres-secrete'),
    'et la clé elle-même n’y est pas',
    JSON.stringify(liste),
  )

  const fichier = path.join(dossier, 'cles-admin.json')
  ok(fs.existsSync(fichier), 'le fichier des clés existe')
  /*
    ⚠️ ON LE DIT DANS L'INTERFACE : ces clés sont en clair sur le disque. Ce banc
       le constate exprès, pour que personne ne croie le contraire en lisant le
       code trop vite.
  */
  ok(
    fs.readFileSync(fichier, 'utf8').includes('ma-cle-tres-secrete'),
    'et il la contient en clair — c’est assumé, et dit au joueur',
  )

  administration.poserCle('1.2.3.4', 7777, '')
  ok(administration.serveursConfigures().length === 0, 'une clé vide retire le serveur')

  titre('Un serveur sans clé ne tente même pas la requête')

  const r = await administration.etat('9.9.9.9', 7777)
  ok(r.ok === false && r.cle === 'err.adminSansCle', 'il répond « pas de clé »', JSON.stringify(r))

  titre('La sonde de latence')

  /*
    ⚠️ « PAS DE RÉPONSE » N'EST PAS « 0 ms ». C'est la même règle que partout
       ailleurs : une mesure absente s'affiche absente.
  */
  const muet = await serveurs.sonder('127.0.0.1', 1, 500)
  ok(muet === null, 'un port muet rend null, pas zéro', String(muet))

  const invalide = await serveurs.sonder('adresse.qui.n.existe.pas.invalid', 7777, 800)
  ok(invalide === null, 'une adresse qui ne résout pas rend null aussi', String(invalide))

  titre('UE4SS est livré, pas téléchargé')

  const archive = ue4ss.cheminArchive ? ue4ss.cheminArchive() : null
  ok(typeof ue4ss.telecharger === 'function', 'le module expose une seule façon de l’obtenir')
  ok(
    ue4ss.preparer === undefined,
    'et plus deux noms pour la même chose',
    String(typeof ue4ss.preparer),
  )

  titre('La mise à jour refuse ce qu’elle ne peut pas vérifier')

  for (const [cas, info] of [
    ['sans empreinte', { nom: 'Voyage-Lanceur-9.9.9-installeur.exe' }],
    ['empreinte trop courte', { nom: 'Voyage-Lanceur-9.9.9-installeur.exe', sha256: 'abc' }],
    ['chemin déguisé en nom', { nom: '../../evil.exe', sha256: 'a'.repeat(64) }],
    ['nom avec séparateur', { nom: 'dossier/ailleurs.exe', sha256: 'a'.repeat(64) }],
    ['pas un exécutable attendu', { nom: 'script.bat', sha256: 'a'.repeat(64) }],
  ]) {
    let refuse = false
    try {
      await maj.telechargerLanceur(info)
    } catch {
      refuse = true
    }
    ok(refuse, `refusé : ${cas}`)
  }

  /*
    ⚠️ L'ADRESSE DE TÉLÉCHARGEMENT EST ÉCRITE EN DUR, PAS LUE DANS LA RÉPONSE. Un
       manifeste pointant ailleurs ferait sinon télécharger — et exécuter —
       n'importe quoi sur la machine du joueur.
  */
  ok(
    maj.BASE_TELECHARGEMENT.startsWith('https://caretakermp.symbioseheritage.ca/'),
    'et elle ne va chercher le fichier que chez nous',
    maj.BASE_TELECHARGEMENT,
  )

  fs.rmSync(dossier, { recursive: true, force: true })

  console.log('\n' + '─'.repeat(60))
  console.log(echecs === 0 ? `TOUT PASSE — ${essais} vérifications` : `${echecs} ÉCHEC(S) sur ${essais}`)
  process.exit(echecs ? 1 : 0)
}

principal().catch((e) => {
  console.error('le banc a planté :', e)
  process.exit(1)
})
