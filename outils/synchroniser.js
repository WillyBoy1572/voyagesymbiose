'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  SYNCHRONISER CE QUE LE LANCEUR EMBARQUE
 * ═══════════════════════════════════════════════════════════════════════════
 *      node outils/synchroniser.js
 *
 *  Le lanceur embarque trois choses qui vivent ailleurs : les deux mods Lua, le
 *  pont, et — depuis la 0.6.6 — le SERVEUR lui-même, pour que n'importe qui
 *  puisse héberger depuis chez lui sans rien installer.
 *
 *  ⚠️ LA COPIE EST EXPLICITE, JAMAIS UN `readdir` AVEUGLE. Un jour ça
 *     embarquerait `donnees/` — c'est-à-dire le monde publié, les identités et
 *     le coffre d'un serveur de test — dans un installeur distribué à tout le
 *     monde.
 *
 *  ⚠️ ON COMPARE LES VERSIONS. Un serveur embarqué d'une version différente de
 *     celle du lanceur, c'est un protocole qui diverge sans que rien ne le dise.
 *     Le script refuse plutôt que de copier.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const RACINE = path.join(__dirname, '..')
const SOURCE = path.resolve(RACINE, '..', 'symbiose-voyage')

/** Exactement ce qui compose le serveur. La même liste que `deployer.js`. */
const FICHIERS_SERVEUR = [
  'package.json',
  'src/server.js',
  'src/config.js',
  'src/protocole.js',
  'src/session.js',
  'src/monde.js',
  'src/commandes.js',
  'src/http.js',
  'src/journal.js',
  'src/sauvegardes.js',
  'src/entites.js',
  'src/identite.js',
  'src/permissions.js',
  'src/moderation.js',
  'src/equipes.js',
  'src/activites.js',
  'src/inventaire.js',
  'src/pnj.js',
  'src/evenements.js',
  'src/temps.js',
  'src/mesures.js',
  'src/ressources.js',
  'src/transport.js',
  'src/annuaire.js',
  'src/reseau.js',
  'src/rendezvous.js',
  'src/percage.js',
  'src/langues.js',
  'src/textes.js',
]

const MODS = ['VoyageLien', 'VoyageSonde']

let copies = 0
let identiques = 0

function copier(de, vers) {
  if (!fs.existsSync(de)) {
    console.log(`  ✘ absent : ${de}`)
    return false
  }
  fs.mkdirSync(path.dirname(vers), { recursive: true })
  const avant = fs.existsSync(vers) ? fs.readFileSync(vers, 'utf8') : null
  const apres = fs.readFileSync(de, 'utf8')
  if (avant === apres) {
    identiques++
    return true
  }
  fs.writeFileSync(vers, apres, 'utf8')
  copies++
  console.log(`  ✔ ${path.relative(RACINE, vers)}`)
  return true
}

function principal() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`\n  le dépôt du serveur est introuvable : ${SOURCE}`)
    process.exit(1)
  }

  const versionLanceur = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8')).version
  const versionServeur = JSON.parse(fs.readFileSync(path.join(SOURCE, 'package.json'), 'utf8')).version

  console.log(`\n── Synchronisation ${'─'.repeat(42)}`)
  console.log(`  lanceur ${versionLanceur} · serveur ${versionServeur}`)

  if (versionLanceur !== versionServeur) {
    console.error(
      `\n  refusé : les versions diffèrent.\n` +
        `  Le serveur embarqué et le lanceur parlent le même protocole : les laisser\n` +
        `  diverger donne un hébergement qui refuse ses propres joueurs sans rien dire.\n`,
    )
    process.exit(1)
  }

  console.log('\n  serveur embarqué :')
  for (const relatif of FICHIERS_SERVEUR) {
    copier(path.join(SOURCE, relatif), path.join(RACINE, 'serveur', relatif))
  }

  console.log('\n  mods :')
  for (const m of MODS) {
    copier(
      path.join(SOURCE, 'jeu', m, 'Scripts', 'main.lua'),
      path.join(RACINE, 'mods', m, 'Scripts', 'main.lua'),
    )
  }

  console.log('\n  pont :')
  copier(path.join(SOURCE, 'pont', 'pont.js'), path.join(RACINE, 'pont', 'pont.js'))

  console.log(`\n  ${copies} fichier(s) mis à jour, ${identiques} déjà à jour.`)
}

principal()
