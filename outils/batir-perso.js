'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LE LANCEUR PERSONNEL — celui qui embarque la sonde max
 * ═══════════════════════════════════════════════════════════════════════════
 *      node outils/batir-perso.js
 *
 *  Il produit `dist-perso/Voyage-Lanceur-PERSO-<version>-installeur.exe`, qui
 *  s'installe À CÔTÉ du lanceur public — pas par-dessus.
 *
 *  Ce qu'il a en plus : le mod `VoyageSondeMax`. Il accroche une vingtaine de
 *  fonctions du jeu pour enregistrer ce qu'elles reçoivent, recense tout ce que
 *  le monde contient, et lit les drapeaux de réplication que les développeurs
 *  ont posés eux-mêmes dans le binaire.
 *
 *  ⚠️ IL S'INSTALLE À CÔTÉ, PAS PAR-DESSUS. Même `appId`, même dossier, et
 *     l'installeur personnel écraserait le lanceur public — ou l'inverse, un
 *     jour où on republie. Deux identités distinctes, deux raccourcis, deux
 *     dossiers : on peut avoir les deux et savoir lequel on lance.
 *
 *  ⚠️ IL NETTOIE DERRIÈRE LUI, MÊME S'IL ÉCHOUE. La sonde max est copiée dans
 *     `mods/` le temps de la construction. Laissée là, la construction publique
 *     suivante l'embarquerait sans que personne ne le remarque — et un joueur
 *     se retrouverait avec un mod qui écrit un fichier de plusieurs mégaoctets
 *     dans son dossier de jeu. D'où le `finally`, et d'où le banc d'essai qui
 *     vérifie l'absence dans le paquet public.
 *
 *  ⚠️ LA SONDE EST VÉRIFIÉE AVANT D'ÊTRE EMBARQUÉE. Une erreur de syntaxe dans
 *     un mod UE4SS fige le jeu au chargement, sans message. On la passe donc
 *     dans un vrai interpréteur Lua d'abord ; si `py` ou `lupa` manquent, on le
 *     dit et on continue, mais on ne fait pas semblant d'avoir vérifié.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const RACINE = path.join(__dirname, '..')
const SOURCE_SONDE = path.resolve(RACINE, '..', 'symbiose-voyage', 'jeu', 'VoyageSondeMax')
const CIBLE_SONDE = path.join(RACINE, 'mods', 'VoyageSondeMax')
const CONFIG = path.join(RACINE, 'electron-builder-perso.json')

const version = JSON.parse(fs.readFileSync(path.join(RACINE, 'package.json'), 'utf8')).version

function dire(t) {
  console.log('  ' + t)
}

/** Vérifie la syntaxe Lua avec un vrai interpréteur. Rend `null` si on n'a pas pu. */
function syntaxeLua(fichier) {
  const script = [
    'import io, sys',
    'try:',
    '    import lupa',
    'except ImportError:',
    '    print("SANS-LUPA")',
    '    sys.exit(0)',
    'L = lupa.LuaRuntime(unpack_returned_tuples=True)',
    's = io.open(sys.argv[1], encoding="utf-8").read()',
    // ⚠️ `load` rend DEUX valeurs ; sans l'envelopper, lupa n'en voit qu'une et
    //    un fichier cassé passe pour bon.
    'r = L.eval(\'function(x) local f, e = load(x, "sonde") return { f = f, e = e } end\')(s)',
    'print("OK" if r["f"] is not None else "CASSE:" + str(r["e"]))',
  ].join('\n')
  try {
    const sortie = execFileSync('py', ['-c', script, fichier], { encoding: 'utf8' }).trim()
    if (sortie === 'SANS-LUPA') return null
    if (sortie === 'OK') return true
    dire('⚠️  ' + sortie)
    return false
  } catch {
    return null
  }
}

function principal() {
  console.log(`\n── Lanceur PERSONNEL ${version} ${'─'.repeat(40)}`)

  if (!fs.existsSync(path.join(SOURCE_SONDE, 'Scripts', 'main.lua'))) {
    console.error(`\n  la sonde max est introuvable : ${SOURCE_SONDE}\n`)
    process.exit(1)
  }

  const verdict = syntaxeLua(path.join(SOURCE_SONDE, 'Scripts', 'main.lua'))
  if (verdict === false) {
    console.error('\n  refusé : la sonde ne se charge pas. Un mod cassé fige le jeu.\n')
    process.exit(1)
  }
  dire(verdict === null ? 'syntaxe Lua : NON VÉRIFIÉE (lupa absent)' : 'syntaxe Lua : ok')

  try {
    fs.rmSync(CIBLE_SONDE, { recursive: true, force: true })
    fs.cpSync(SOURCE_SONDE, CIBLE_SONDE, { recursive: true })
    dire('sonde max copiée dans mods/')

    /*
      ⚠️ UNE IDENTITÉ À PART, PAS UNE VARIANTE. `appId`, `productName`, le nom
         du raccourci et le dossier d'installation changent tous : les deux
         lanceurs cohabitent, et on sait lequel on ouvre.
    */
    fs.writeFileSync(
      CONFIG,
      JSON.stringify(
        {
          appId: 'ca.symbioseheritage.voyage.lanceur.perso',
          productName: 'Voyage Lanceur PERSO',
          copyright: 'Symbiose Heritage Hosting',
          directories: { output: 'dist-perso', buildResources: 'ressources' },
          files: [
            'src/**/*',
            'ui/**/*',
            'mods/**/*',
            'pont/**/*',
            'serveur/**/*',
            'ressources/ue4ss/**/*',
            'package.json',
          ],
          asarUnpack: ['mods/**/*', 'pont/**/*', 'serveur/**/*', 'ressources/ue4ss/**/*'],
          win: {
            target: ['nsis'],
            icon: 'ressources/voyage.ico',
            artifactName: 'Voyage-Lanceur-PERSO-${version}-installeur.exe',
          },
          nsis: {
            oneClick: false,
            perMachine: false,
            allowToChangeInstallationDirectory: true,
            createDesktopShortcut: true,
            createStartMenuShortcut: true,
            shortcutName: 'Voyage Lanceur PERSO',
            installerIcon: 'ressources/voyage.ico',
            uninstallerIcon: 'ressources/voyage.ico',
            deleteAppDataOnUninstall: false,
          },
          /*
            ⚠️ PAS DE `protocols` ICI. Deux applications qui réclament `voyage://`
               se disputent le lien d'invitation, et c'est la dernière installée
               qui gagne — autrement dit le lanceur public cesserait d'ouvrir les
               liens sans prévenir.
          */
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )

    dire('construction…')
    /*
      ⚠️ ON APPELLE LE BINAIRE DE `node_modules`, PAS `npx`. `npx.cmd` n'est pas
         toujours sur le chemin quand on lance par `npm run`, et l'erreur qui
         remonte alors (`spawn ENOENT`, pid 0) ne nomme rien d'utile. Celui-ci
         est là par construction : c'est la dépendance qu'on vient d'installer.
    */
    const binaire = path.join(
      RACINE,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder',
    )
    if (!fs.existsSync(binaire)) {
      throw new Error(`electron-builder est introuvable : ${binaire} — lance \`npm install\` d'abord.`)
    }
    execFileSync(binaire, ['--win', '--config', CONFIG], {
      cwd: RACINE,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    })
  } finally {
    /*
      ⚠️ ON NETTOIE MÊME QUAND ÇA RATE. Une sonde oubliée dans `mods/` partirait
         dans la construction publique suivante, et personne ne le verrait avant
         qu'un joueur trouve un fichier de plusieurs mégaoctets dans son dossier
         de jeu.
    */
    fs.rmSync(CIBLE_SONDE, { recursive: true, force: true })
    fs.rmSync(CONFIG, { force: true })
    dire('mods/ remis dans son état public')
  }

  const dossier = path.join(RACINE, 'dist-perso')
  const exe = fs.existsSync(dossier)
    ? fs.readdirSync(dossier).filter((f) => f.endsWith('.exe') && !f.includes('uninstall'))
    : []
  console.log('')
  for (const f of exe) {
    const o = fs.statSync(path.join(dossier, f)).size
    dire(`${f} — ${Math.round(o / 1048576)} Mo`)
  }
  dire('il s’installe à côté du lanceur public, pas par-dessus.')
  console.log('')
}

principal()
