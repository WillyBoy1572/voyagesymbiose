'use strict'

/**
 * Essai de detection du dossier du jeu.
 *
 * ⚠️ IL REPRODUIT LE PIEGE REEL : le jeu s'installe dans un dossier nomme
 *    « Voyage », qui contient `Voyage\Binaries\Win64` (le jeu) ET
 *    `Engine\Binaries\Win64` (le rapporteur de plantage d'Unreal). Chercher
 *    « voyage » dans le chemin complet attrapait les deux, et « Engine »
 *    passant avant dans l'ordre alphabetique, UE4SS finissait au mauvais
 *    endroit — installation silencieusement inutile.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const jeu = require('../src/jeu')

let echecs = 0
function ok(condition, libelle, detail = '') {
  console.log(`  ${condition ? '✔' : '✘'} ${libelle}${condition ? '' : ` — ${detail}`}`)
  if (!condition) echecs++
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'essai-voyage-'))
const racine = path.join(base, 'Voyage')
const binJeu = path.join(racine, 'Voyage', 'Binaries', 'Win64')
const binEngine = path.join(racine, 'Engine', 'Binaries', 'Win64')

fs.mkdirSync(binJeu, { recursive: true })
fs.mkdirSync(binEngine, { recursive: true })
fs.writeFileSync(path.join(binJeu, 'Voyage-Win64-Shipping.exe'), '')
fs.writeFileSync(path.join(binEngine, 'CrashReportClient.exe'), '')
fs.writeFileSync(path.join(binEngine, 'CrashReportClientEditor-Win64-Shipping.exe'), '')

console.log('\n── Détection du bon dossier ' + '─'.repeat(30))

const bin = jeu.dossierBinaires(racine)
ok(bin === binJeu, 'le dossier du JEU est retenu, pas celui d’Engine', bin)

const exe = jeu.executableJeu(racine)
ok(exe === path.join(binJeu, 'Voyage-Win64-Shipping.exe'), 'le bon exécutable est trouvé', String(exe))

// Un dossier qui n'a QUE Engine ne doit rien rendre d'utile.
const seul = path.join(base, 'SansJeu')
fs.mkdirSync(path.join(seul, 'Engine', 'Binaries', 'Win64'), { recursive: true })
fs.writeFileSync(path.join(seul, 'Engine', 'Binaries', 'Win64', 'CrashReportClient.exe'), '')
ok(jeu.dossierBinaires(seul) === null, 'un dossier sans jeu ne rend rien', String(jeu.dossierBinaires(seul)))

const etat = jeu.etat(racine)
ok(etat.binaires === binJeu, 'l’état pointe sur le bon dossier')
ok(etat.ue4ss === false && etat.mod === false, 'rien n’est signalé comme installé sur une copie vierge')

fs.rmSync(base, { recursive: true, force: true })

console.log('\n' + (echecs ? `${echecs} ÉCHEC(S)` : 'TOUT PASSE'))
process.exit(echecs ? 1 : 0)
