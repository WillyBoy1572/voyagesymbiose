'use strict'

/**
 * Verifie ce qui est REELLEMENT parti dans l'exécutable.
 *
 * ⚠️ UN FICHIER OUBLIE NE SE VOIT PAS A LA CONSTRUCTION. `electron-builder`
 *    n'emballe que ce que `build.files` liste : ajouter `langues.js` au
 *    projet sans l'ajouter au paquet donne une interface muette chez le
 *    joueur, et rien du tout dans le journal de construction.
 *
 * ⚠️ `pont.js` ET LES MODS DOIVENT ETRE HORS DE L'ASAR. Le premier est lance
 *    comme programme, les seconds sont copies dans le dossier du jeu :
 *    restes dans l'archive, ni l'un ni l'autre ne fonctionne.
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const asar = require('@electron/asar')

const RACINE = path.join(__dirname, '..')
const PAQUET = path.join(RACINE, 'dist', 'win-unpacked')

let echecs = 0
const ok = (c, l, d = '') => {
  console.log(`  ${c ? '✔' : '✘'} ${l}${c ? '' : ` — ${d}`}`)
  if (!c) echecs++
}

console.log('\n── Ce qui est parti dans l’exécutable ' + '─'.repeat(22))

if (!fs.existsSync(PAQUET)) {
  console.log('\n  Rien à vérifier : lance « npm run batir » d’abord.')
  process.exit(0)
}

const liste = asar.listPackage(path.join(PAQUET, 'resources', 'app.asar'))
const dedans = (nom) => liste.some((p) => p.replace(/\\/g, '/').endsWith(`/${nom}`))

for (const f of [
  'ui/index.html',
  'ui/style.css',
  'ui/app.js',
  'ui/langues.js',
  'ui/marque.svg',
  'src/principal.js',
  'src/passerelle.js',
  'src/jeu.js',
  'src/lien.js',
  'src/serveurs.js',
  'src/ue4ss.js',
  'src/sauvegardes.js',
  /*
    ⚠️ SANS `identite.js`, LE LANCEUR NE SIGNE PLUS RIEN. Tout le monde entre en
       anonyme, les rôles disparaissent, et rien ne le dit : un fichier oublié
       dans le paquet est exactement le genre de panne qu'on ne voit qu'en
       production.
  */
  'src/identite.js',
  /*
    ⚠️ SANS `heberger.js`, LE BOUTON « HÉBERGER » NE FAIT RIEN. Et sans le
       dossier `serveur/`, il n'a rien à démarrer : ce sont les deux moitiés de
       la même fonctionnalité, et un fichier oublié dans le paquet est
       exactement le genre de panne qu'on ne voit qu'en production.
  */
  'src/heberger.js',
]) {
  ok(dedans(path.basename(f)), `${f} est dans le paquet`)
}

/*
  Rien du banc d'essai ne doit voyager. La seule archive admise est celle
  d'UE4SS, qu'on livre volontairement : tout autre `.zip` ou `.rar` est un
  oubli.
*/
const UE4SS_ARCHIVE = 'UE4SS_v3.0.1-1152-ge3ba1016.zip'
const UE4SS_EMPREINTE = 'af8ea9d8975e8eff7967423f43b8b50875e66a29a0f434cffce6e0867ea17252'

const intrus = liste.filter(
  (p) => /stub|node_modules|\.rar$|\.zip$/i.test(p) && !p.endsWith(UE4SS_ARCHIVE),
)
ok(intrus.length === 0, 'aucun fichier indésirable embarqué', intrus.slice(0, 3).join(', '))

// Hors de l'archive, la ou on peut les lancer et les copier.
const horsAsar = path.join(PAQUET, 'resources', 'app.asar.unpacked')
ok(fs.existsSync(path.join(horsAsar, 'pont', 'pont.js')), 'pont.js est hors de l’asar')
for (const mod of ['VoyageLien', 'VoyageSonde']) {
  ok(
    fs.existsSync(path.join(horsAsar, 'mods', mod, 'Scripts', 'main.lua')),
    `le mod ${mod} est hors de l’asar`,
  )
}

/*
  Le serveur embarque : c'est lui qui permet d'heberger depuis chez soi.

  ⚠️ IL DOIT SORTIR DE L'ARCHIVE. Un fichier reste dans l'asar ne peut pas etre
     lance comme programme : le bouton « Heberger » echouerait au demarrage,
     avec une erreur que personne ne saurait lire.

  ⚠️ ET SA VERSION DOIT ETRE CELLE DU LANCEUR. Un serveur embarque d'une autre
     version, c'est un protocole qui diverge sans que rien ne le dise.
*/
ok(
  fs.existsSync(path.join(horsAsar, 'serveur', 'src', 'server.js')),
  'le serveur embarque est hors de l’asar',
)
try {
  const paquetServeur = JSON.parse(
    fs.readFileSync(path.join(horsAsar, 'serveur', 'package.json'), 'utf8'),
  )
  const paquetLanceur = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8'))
  ok(
    paquetServeur.version === paquetLanceur.version,
    'et il porte la meme version que le lanceur',
    `${paquetServeur.version} vs ${paquetLanceur.version}`,
  )
} catch (e) {
  ok(false, 'et il porte la meme version que le lanceur', e.message)
}

for (const f of ['config.js', 'protocole.js', 'session.js', 'annuaire.js', 'pnj.js']) {
  ok(
    fs.existsSync(path.join(horsAsar, 'serveur', 'src', f)),
    `serveur/src/${f} est livre`,
  )
}

/*
  UE4SS est livre avec le lanceur, pas telecharge.

  ⚠️ IL DOIT ETRE HORS DE L'ASAR. PowerShell ne sait pas lire dans `app.asar` :
     range a l'interieur, l'archive serait invisible au moment de l'extraire, et
     l'installation echouerait chez le joueur sans rien dire ici.
*/
const archiveUe4ss = path.join(horsAsar, 'ressources', 'ue4ss', UE4SS_ARCHIVE)
ok(fs.existsSync(archiveUe4ss), 'l’archive UE4SS est livrée, hors de l’asar')
if (fs.existsSync(archiveUe4ss)) {
  const vue = crypto.createHash('sha256').update(fs.readFileSync(archiveUe4ss)).digest('hex')
  ok(vue === UE4SS_EMPREINTE, 'l’archive UE4SS correspond à son empreinte', vue)
}
ok(
  fs.existsSync(path.join(horsAsar, 'ressources', 'ue4ss', 'LICENSE-UE4SS.txt')),
  'la licence MIT d’UE4SS accompagne l’archive',
)

// L'executable, son icone et son identite.
const exe = path.join(PAQUET, 'Voyage Lanceur.exe')
ok(fs.existsSync(exe), 'l’exécutable existe')
ok(fs.existsSync(path.join(RACINE, 'ressources', 'voyage.ico')), 'l’icône existe')

const installeurs = fs.existsSync(path.join(RACINE, 'dist'))
  ? fs.readdirSync(path.join(RACINE, 'dist')).filter((f) => /installeur\.exe$/i.test(f))
  : []
ok(installeurs.length === 1, 'un seul installeur à distribuer', installeurs.join(', '))

if (installeurs[0]) {
  const mo = fs.statSync(path.join(RACINE, 'dist', installeurs[0])).size / 1048576
  console.log(`\n  ${installeurs[0]} — ${mo.toFixed(0)} Mo`)
}

console.log('\n' + (echecs ? `${echecs} ÉCHEC(S)` : 'TOUT PASSE'))
process.exit(echecs ? 1 : 0)
