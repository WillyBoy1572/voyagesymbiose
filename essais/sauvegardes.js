'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LES SAUVEGARDES : LE GARDE-FOU ET L'ALLER-RETOUR
 * ═══════════════════════════════════════════════════════════════════════════
 *  ⚠️ LE PREMIER BLOC EST LE PLUS IMPORTANT DU LANCEUR. `nomAcceptable` est
 *     ce qui empeche une archive hostile d'ecrire ailleurs que dans le
 *     dossier de sauvegardes — la faille « zip slip ». Chaque ligne ici
 *     correspond a une facon connue de s'echapper d'un dossier.
 */

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const s = require('../src/sauvegardes')

let echecs = 0
const ok = (c, l, d = '') => {
  console.log(`  ${c ? '✔' : '✘'} ${l}${c ? '' : ` — ${d}`}`)
  if (!c) echecs++
}

async function principal() {
  console.log('\n── Le garde-fou des archives ' + '─'.repeat(30))

  const refuses = [
    ['../evasion.sav', 'remonter d’un dossier'],
    ['..\\evasion.sav', 'remonter, à la Windows'],
    ['a/../../evasion.sav', 'remonter au milieu du chemin'],
    ['C:\\Windows\\System32\\truc.sav', 'chemin absolu Windows'],
    ['/etc/passwd', 'chemin absolu Unix'],
    ['a/b/c/trop-profond.sav', 'trop de niveaux'],
    ['virus.exe', 'exécutable'],
    ['script.ps1', 'script PowerShell'],
    ['truc.sav.exe', 'double extension'],
    ['sauvegarde', 'sans extension'],
    ['fichier\u0000.sav', 'octet nul'],
    ['dossier/', 'un dossier, pas un fichier'],
    ['', 'nom vide'],
  ]
  for (const [nom, pourquoi] of refuses) {
    ok(s.nomAcceptable(nom) === false, `refusé : ${pourquoi}`, JSON.stringify(nom))
  }

  const acceptes = ['Sauvegarde.sav', 'SaveGames/Partie 1.sav', 'reglages.json', 'monde (2).sav', 'truc.dat']
  for (const nom of acceptes) {
    ok(s.nomAcceptable(nom) === true, `accepté : ${nom}`)
  }

  console.log('\n── Archive : aller-retour réel ' + '─'.repeat(28))

  const bac = fs.mkdtempSync(path.join(os.tmpdir(), 'voyage-essai-sv-'))
  const source = path.join(bac, 'source')
  fs.mkdirSync(source)
  fs.writeFileSync(path.join(source, 'Partie1.sav'), 'contenu de la partie un')
  fs.writeFileSync(path.join(source, 'Partie2.sav'), 'contenu de la partie deux')
  fs.writeFileSync(path.join(source, 'notes.txt'), 'ceci ne doit PAS être réinstallé')

  const archive = path.join(bac, 'monde.zip')
  await s.compresser(source, archive)
  ok(fs.existsSync(archive) && fs.statSync(archive).size > 0, 'l’archive est créée')

  const entrees = await s.contenu(archive)
  ok(entrees.length === 3, 'les trois fichiers sont dedans', JSON.stringify(entrees.map((e) => e.nom)))

  const gardees = entrees.filter((e) => s.nomAcceptable(e.nom)).map((e) => e.nom)
  ok(gardees.length === 2, 'le .txt est écarté à l’installation', gardees.join(', '))
  ok(!gardees.includes('notes.txt'), 'notes.txt n’est pas retenu')

  const ouvert = await s.decompresser(archive, path.join(bac, 'ouvert'))
  ok(
    fs.readFileSync(path.join(ouvert, 'Partie1.sav'), 'utf8') === 'contenu de la partie un',
    'le contenu revient intact après l’aller-retour',
  )

  console.log('\n── Le dossier du jeu ' + '─'.repeat(38))

  const vrai = s.dossierSauvegardes()
  ok(
    vrai === null || vrai.includes('Voyage'),
    'le dossier de sauvegardes est cherché dans le profil, pas dans le jeu',
    String(vrai),
  )
  ok(
    s.dossierSauvegardes(source) === source,
    'un dossier choisi à la main est respecté',
    String(s.dossierSauvegardes(source)),
  )

  const fichiers = s.lister(source)
  ok(fichiers.length === 3, 'on liste ce qu’il y a', String(fichiers.length))
  ok(
    fichiers[0].empreinte && fichiers[0].empreinte.length === 64,
    'chaque fichier a son empreinte',
    String(fichiers[0].empreinte),
  )

  fs.rmSync(bac, { recursive: true, force: true })

  console.log('\n' + (echecs ? `${echecs} ÉCHEC(S)` : 'TOUT PASSE'))
  process.exit(echecs ? 1 : 0)
}

principal().catch((e) => {
  console.error('essai planté :', e.message)
  process.exit(1)
})
