'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TROUVER LE JEU, ET Y POSER CE QU'IL FAUT
 * ═══════════════════════════════════════════════════════════════════════════
 *  The Last Caretaker — appid Steam 1783560, nom interne « Voyage ».
 *
 *  ⚠️ ON NE DEVINE PAS LE CHEMIN. « C:\Program Files (x86)\Steam\... » est
 *     faux chez la moitie des gens : Steam accepte plusieurs bibliotheques,
 *     souvent sur un autre disque. On lit donc les fichiers de Steam plutot
 *     que d'esperer.
 *
 *  ⚠️ ON N'ECRASE JAMAIS SANS SAUVEGARDER. Installer par-dessus une
 *     installation existante renomme l'ancienne en `.avant-symbiose` : si on
 *     casse quelque chose, le joueur peut revenir en arriere sans reinstaller
 *     le jeu.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const APPID = '1783560'
const NOM_JEU = 'The Last Caretaker'

/*
  ⚠️ RIEN DE VISIBLE N'EST ECRIT EN DUR ICI. Le processus principal ne sait
     pas dans quelle langue le joueur a mis le lanceur : il renvoie une CLE
     et ses valeurs, et la page traduit. Une phrase francaise ecrite ici
     ressortirait en francais au milieu d'une interface en anglais.
*/
/** Une ligne de journal traduisible. */
const dit = (cle, valeurs) => ({ cle, valeurs })
/** Une erreur traduisible : le message reste en secours si la cle manque. */
function souci(cle, message, valeurs) {
  return Object.assign(new Error(message), { cle, valeurs })
}

// ── Trouver Steam ───────────────────────────────────────────────────────────

function lireRegistre(cle, valeur) {
  return new Promise((resolve) => {
    execFile('reg', ['query', cle, '/v', valeur], { windowsHide: true }, (err, sortie) => {
      if (err) return resolve(null)
      const m = sortie.match(/REG_SZ\s+(.+)/)
      resolve(m ? m[1].trim() : null)
    })
  })
}

async function dossierSteam() {
  const pistes = [
    ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
    ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath'],
  ]
  for (const [cle, valeur] of pistes) {
    const v = await lireRegistre(cle, valeur)
    if (v && fs.existsSync(v)) return v.replace(/\//g, '\\')
  }
  // Repli : les emplacements habituels, au cas ou le registre serait muet.
  for (const p of ['C:\\Program Files (x86)\\Steam', 'C:\\Steam', 'D:\\Steam']) {
    if (fs.existsSync(p)) return p
  }
  return null
}

/**
 * Toutes les bibliotheques Steam, pas seulement la principale.
 *
 * ⚠️ `libraryfolders.vdf` A CHANGE DE FORME AU FIL DES VERSIONS. On ne le
 *    parse pas comme du VDF structure : on releve tous les chemins entre
 *    guillemets, ce qui marche avec l'ancien comme avec le nouveau format.
 */
function bibliotheques(steam) {
  const chemins = new Set([steam])
  const vdf = path.join(steam, 'steamapps', 'libraryfolders.vdf')
  if (fs.existsSync(vdf)) {
    const texte = fs.readFileSync(vdf, 'utf8')
    for (const m of texte.matchAll(/"path"\s+"([^"]+)"/g)) chemins.add(m[1].replace(/\\\\/g, '\\'))
    for (const m of texte.matchAll(/"\d+"\s+"([A-Za-z]:\\\\[^"]+)"/g)) chemins.add(m[1].replace(/\\\\/g, '\\'))
  }
  return [...chemins]
}

/** Le dossier d'installation du jeu, ou null. */
async function trouverJeu() {
  const steam = await dossierSteam()
  if (steam) {
    for (const lib of bibliotheques(steam)) {
      const manifeste = path.join(lib, 'steamapps', `appmanifest_${APPID}.acf`)
      if (!fs.existsSync(manifeste)) continue
      const m = fs.readFileSync(manifeste, 'utf8').match(/"installdir"\s+"([^"]+)"/)
      if (!m) continue
      const dossier = path.join(lib, 'steamapps', 'common', m[1])
      if (fs.existsSync(dossier)) return { dossier, source: 'Steam' }
    }
  }
  return null
}

/**
 * Le dossier ou vivent l'executable et les greffons : `.../Binaries/Win64`.
 *
 * ⚠️ C'EST LA QUE VA `dwmapi.dll`, PAS A LA RACINE DU JEU. Pose a la racine,
 *    il n'est jamais charge et le joueur croit que l'installation a rate.
 */
function dossierBinaires(dossierJeu) {
  const candidats = []
  for (const e of fs.readdirSync(dossierJeu, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    /*
      ⚠️ « Engine » CONTIENT AUSSI UN Binaries/Win64, mais c'est celui du
         rapporteur de plantage d'Unreal, pas du jeu. Y poser UE4SS ne fait
         rien du tout.
    */
    if (/^engine$/i.test(e.name)) continue
    const p = path.join(dossierJeu, e.name, 'Binaries', 'Win64')
    if (fs.existsSync(p)) candidats.push(p)
  }

  /*
    ⚠️ ON RECONNAIT LE BON DOSSIER A SON EXECUTABLE, PAS A SON NOM. La version
       precedente cherchait « voyage » dans le CHEMIN COMPLET : comme le jeu
       est installe dans un dossier nomme « Voyage », le chemin de Engine
       contenait le mot lui aussi, et « Engine » passant avant dans l'ordre
       alphabetique, UE4SS atterrissait a cote du rapporteur de plantage.
  */
  const avecJeu = candidats.find((c) => Boolean(executableDans(c)))
  return avecJeu ?? candidats[0] ?? null
}

/** L'executable de jeu d'un dossier Win64, en ecartant les outils d'Unreal. */
function executableDans(dossierWin64) {
  let fichiers
  try {
    fichiers = fs.readdirSync(dossierWin64)
  } catch {
    return null
  }
  const exe = fichiers.find(
    (f) => /-win64-shipping\.exe$/i.test(f) && !/crashreport|unrealcefsubprocess|epicwebhelper/i.test(f),
  )
  return exe ? path.join(dossierWin64, exe) : null
}

function executableJeu(dossierJeu) {
  const bin = dossierBinaires(dossierJeu)
  if (bin) {
    const exe = executableDans(bin)
    if (exe) return exe
  }
  const racine = fs.readdirSync(dossierJeu).find((f) => /\.exe$/i.test(f) && !/crashreport/i.test(f))
  return racine ? path.join(dossierJeu, racine) : null
}

function etat(dossierJeu) {
  if (!dossierJeu || !fs.existsSync(dossierJeu)) return { jeu: false }
  const bin = dossierBinaires(dossierJeu)
  if (!bin) return { jeu: true, binaires: null, ue4ss: false, mod: false }

  const ue4ss = fs.existsSync(path.join(bin, 'dwmapi.dll')) && fs.existsSync(path.join(bin, 'ue4ss', 'UE4SS.dll'))
  const mod = fs.existsSync(path.join(bin, 'ue4ss', 'Mods', 'VoyageSonde', 'Scripts', 'main.lua'))
  return { jeu: true, binaires: bin, ue4ss, mod, executable: executableJeu(dossierJeu) }
}

// ── Installation ────────────────────────────────────────────────────────────

function copierDossier(source, cible) {
  fs.mkdirSync(cible, { recursive: true })
  for (const e of fs.readdirSync(source, { withFileTypes: true })) {
    const s = path.join(source, e.name)
    const c = path.join(cible, e.name)
    if (e.isDirectory()) copierDossier(s, c)
    else fs.copyFileSync(s, c)
  }
}

/**
 * Les seuls dossiers de mods qui nous appartiennent.
 *
 * ⚠️ TOUT CE QUI N'EST PAS DANS CETTE LISTE APPARTIENT A QUELQU'UN D'AUTRE.
 *    On l'installe, on le retire, on ne touche a rien de plus — ni aux mods
 *    des autres auteurs, ni a ceux livres avec UE4SS.
 */
const NOS_MODS = ['VoyageLien', 'VoyageSonde']

/** Depose quand c'est NOUS qui avons installe UE4SS, et pas le joueur. */
const MARQUE_UE4SS = '.voyage-a-pose-ue4ss'

/** UE4SS est-il deja en place et fonctionnel dans ce dossier ? */
function ue4ssPresent(bin) {
  return (
    fs.existsSync(path.join(bin, 'ue4ss', 'UE4SS.dll')) &&
    POINTS_ACCROCHE.some((n) => fs.existsSync(path.join(bin, n)))
  )
}

/**
 * Signale les dossiers Win64 ou un UE4SS traine sans servir a rien.
 *
 * ⚠️ ON SIGNALE, ON NE SUPPRIME PAS. Une installation dans
 *    `Engine\Binaries\Win64` ne se charge jamais et trompe le joueur — mais
 *    elle ne nous appartient pas. L'effacer reviendrait a desinstaller le
 *    travail d'un autre outil, Vortex compris, sans rien demander.
 */
function signalerAilleurs(dossierJeu, binGarde) {
  const vus = []
  for (const e of fs.readdirSync(dossierJeu, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const bin = path.join(dossierJeu, e.name, 'Binaries', 'Win64')
    if (bin === binGarde || !fs.existsSync(bin)) continue
    if (fs.existsSync(path.join(bin, 'ue4ss'))) {
      vus.push(path.join(e.name, 'Binaries', 'Win64', 'ue4ss'))
    }
  }
  return vus
}

/**
 * Installe nos mods dans le jeu, et UE4SS seulement s'il manque.
 *
 * `sourceUe4ss` = dossier extrait de la release UE4SS (contenant dwmapi.dll).
 * `sourceMods`  = dossier qui contient nos mods (un sous-dossier par mod).
 */
function installer({ dossierJeu, sourceUe4ss, sourceMods }) {
  const journal = []
  const bin = dossierBinaires(dossierJeu)
  if (!bin) throw souci('err.binaires', 'Dossier Binaries/Win64 introuvable dans le jeu.')

  for (const p of signalerAilleurs(dossierJeu, bin)) journal.push(dit('jrn.egare', { chemin: p }))

  /*
    ⚠️ UN UE4SS DEJA EN PLACE N'EST PAS REMPLACE. Beaucoup de joueurs l'ont
       installe eux-memes ou par l'extension Vortex du jeu, avec d'autres mods
       a cote. L'ancienne version mettait ce dossier de cote et en posait un
       neuf : tous ces mods disparaissaient d'un coup, et le joueur ne
       comprenait pas pourquoi. On se contente d'ajouter les notres.
  */
  const deja = ue4ssPresent(bin)
  if (deja) {
    journal.push(dit('jrn.ue4ssDeja'))
  } else if (sourceUe4ss) {
    const dll = path.join(sourceUe4ss, 'dwmapi.dll')
    const dossierUe4ss = path.join(sourceUe4ss, 'ue4ss')
    if (!fs.existsSync(dll) || !fs.existsSync(dossierUe4ss)) {
      throw souci('err.pasUne4ss', 'Ce dossier ne ressemble pas à une release UE4SS.')
    }
    fs.copyFileSync(dll, path.join(bin, 'dwmapi.dll'))
    copierDossier(dossierUe4ss, path.join(bin, 'ue4ss'))
    fs.writeFileSync(path.join(bin, 'ue4ss', MARQUE_UE4SS), '', 'utf8')
    journal.push(dit('jrn.ue4ssInstalle'))

    // La console n'est allumee que sur NOTRE installation : les reglages d'un
    // UE4SS deja en place sont ceux du joueur.
    if (allumerConsole(bin)) journal.push(dit('jrn.console'))
  } else {
    throw souci('err.ue4ssManquant', 'UE4SS est absent et aucune source n’a été fournie.')
  }

  // Nos mods, et uniquement les notres.
  const cibleMods = path.join(bin, 'ue4ss', 'Mods')
  fs.mkdirSync(cibleMods, { recursive: true })
  const poses = []
  for (const nom of NOS_MODS) {
    const source = path.join(sourceMods, nom)
    if (!fs.existsSync(source)) continue
    copierDossier(source, path.join(cibleMods, nom))
    poses.push(nom)
    journal.push(dit('jrn.modPose', { nom }))
  }

  /*
    ⚠️ ON AJOUTE UNE LIGNE, ON NE REECRIT PAS LE FICHIER. Remplacer mods.txt
       desactiverait les mods livres avec UE4SS et ceux des autres auteurs ;
       le joueur perdrait tout sans comprendre pourquoi.
  */
  const fichierMods = path.join(cibleMods, 'mods.txt')
  let contenu = fs.existsSync(fichierMods) ? fs.readFileSync(fichierMods, 'utf8') : ''
  for (const nom of poses) {
    if (new RegExp(`^\\s*${nom}\\s*:`, 'm').test(contenu)) continue
    // Avant la section des keybinds, qui doit rester en dernier.
    const marque = contenu.indexOf('; Built-in keybinds')
    const ligne = `${nom} : 1\n`
    contenu = marque >= 0 ? contenu.slice(0, marque) + ligne + '\n' + contenu.slice(marque) : contenu + ligne
    journal.push(dit('jrn.modActive', { nom }))
  }
  fs.writeFileSync(fichierMods, contenu, 'utf8')

  return journal
}

/**
 * Retire nos mods.
 *
 * ⚠️ ON NE DESINSTALLE UE4SS QUE SI C'EST NOUS QUI L'AVONS POSE, ce que dit
 *    la marque deposee a l'installation. Sinon on emporterait avec lui tous
 *    les mods du joueur — la version precedente effacait le dossier entier.
 */
function desinstaller(dossierJeu) {
  const bin = dossierBinaires(dossierJeu)
  if (!bin) throw souci('err.binaires', 'Dossier Binaries/Win64 introuvable.')
  const journal = []
  const cibleMods = path.join(bin, 'ue4ss', 'Mods')

  for (const nom of NOS_MODS) {
    const p = path.join(cibleMods, nom)
    if (!fs.existsSync(p)) continue
    fs.rmSync(p, { recursive: true, force: true })
    journal.push(dit('jrn.retire', { quoi: nom }))
  }

  // Nos lignes sortent de mods.txt ; celles des autres restent.
  const fichierMods = path.join(cibleMods, 'mods.txt')
  if (fs.existsSync(fichierMods)) {
    const avant = fs.readFileSync(fichierMods, 'utf8')
    const apres = avant
      .split(/\r?\n/)
      .filter((l) => !NOS_MODS.some((n) => new RegExp(`^\\s*${n}\\s*:`).test(l)))
      .join('\n')
    if (apres !== avant) fs.writeFileSync(fichierMods, apres, 'utf8')
  }

  const marque = path.join(bin, 'ue4ss', MARQUE_UE4SS)
  if (fs.existsSync(marque)) {
    for (const cible of ['ue4ss', 'dwmapi.dll']) {
      const p = path.join(bin, cible)
      if (!fs.existsSync(p)) continue
      fs.rmSync(p, { recursive: true, force: true })
      journal.push(dit('jrn.retire', { quoi: cible }))
    }
  } else {
    journal.push(dit('jrn.ue4ssGarde'))
  }

  return journal
}

/**
 * Les noms sous lesquels un greffon peut se faire charger par un jeu Unreal.
 *
 * ⚠️ UN JEU NE CHARGE QUE LES DLL QU'IL IMPORTE VRAIMENT. UE4SS est livre en
 *    `dwmapi.dll`, mais si l'executable n'importe pas dwmapi, le fichier reste
 *    sur le disque sans jamais etre lu : aucun message, aucune erreur, et le
 *    joueur croit que l'installation a rate. D'ou cette liste de replis.
 */
const POINTS_ACCROCHE = ['dwmapi.dll', 'xinput1_3.dll', 'dinput8.dll', 'd3d11.dll', 'winmm.dll', 'version.dll']

/**
 * Allume la console d'UE4SS.
 *
 * ⚠️ ELLE EST ETEINTE DANS LA RELEASE (`ConsoleEnabled = 0`,
 *    `GuiConsoleEnabled = 0`). Sans elle, rien ne prouve qu'UE4SS s'est
 *    charge : pas de fenetre, pas de sortie Lua, aucun retour. On l'allume,
 *    quitte a ce que le joueur l'eteigne plus tard.
 */
function allumerConsole(bin) {
  const fichier = path.join(bin, 'ue4ss', 'UE4SS-settings.ini')
  if (!fs.existsSync(fichier)) return false
  let texte = fs.readFileSync(fichier, 'utf8')
  const avant = texte
  texte = texte
    .replace(/^\s*ConsoleEnabled\s*=.*$/m, 'ConsoleEnabled = 1')
    .replace(/^\s*GuiConsoleEnabled\s*=.*$/m, 'GuiConsoleEnabled = 1')
  if (texte === avant) return false
  fs.writeFileSync(fichier, texte, 'utf8')
  return true
}

/**
 * Quel point d'accroche est en place, et lesquels restent a essayer.
 */
function accrocheActuelle(bin) {
  return POINTS_ACCROCHE.filter((n) => fs.existsSync(path.join(bin, n)))
}

/**
 * Change le nom sous lequel UE4SS se fait charger.
 * On garde UNE seule copie : deux greffons charges en meme temps se marchent
 * dessus et le jeu plante au demarrage.
 */
function changerAccroche(dossierJeu, nom) {
  if (!POINTS_ACCROCHE.includes(nom)) throw souci('err.accrocheInconnue', 'Point d’accroche inconnu.')
  const bin = dossierBinaires(dossierJeu)
  if (!bin) throw souci('err.binaires', 'Binaires introuvables.')

  const presents = accrocheActuelle(bin)
  if (presents.length === 0) throw souci('err.ue4ssPasInstalle', 'UE4SS n’est pas installé.')

  const source = path.join(bin, presents[0])
  const cible = path.join(bin, nom)
  if (source !== cible) fs.copyFileSync(source, cible)
  for (const autre of presents) {
    if (autre !== nom) fs.rmSync(path.join(bin, autre), { force: true })
  }
  return nom
}

/**
 * Ce que le lanceur peut dire sans que le joueur fouille des dossiers.
 *
 * ⚠️ `UE4SS.log` EST LA PREUVE. S'il existe, UE4SS s'est charge ; s'il
 *    n'existe pas apres un lancement, c'est le point d'accroche qui est en
 *    cause, pas le mod.
 */
function diagnostiquer(dossierJeu) {
  const bin = dossierBinaires(dossierJeu)
  if (!bin) throw souci('err.binaires', 'Binaires introuvables.')

  /*
    ⚠️ LE JOURNAL EST DANS `ue4ss/`, PAS A COTE DE LA DLL. UE4SS l'annonce
       lui-meme : « log directory: …\Binaries\Win64\ue4ss ». Le chercher
       un cran trop haut faisait dire « UE4SS ne se charge pas » a un
       diagnostic pendant qu'UE4SS tournait parfaitement — le pire genre de
       faux negatif, celui qui envoie chercher un probleme inexistant.
       Les anciennes versions l'ecrivaient a la racine : on regarde les deux.
  */
  const journal = [path.join(bin, 'ue4ss', 'UE4SS.log'), path.join(bin, 'UE4SS.log')].find((c) =>
    fs.existsSync(c),
  )
  const rapport = [path.join(bin, 'ue4ss', 'VoyageSonde.txt'), path.join(bin, 'VoyageSonde.txt')].find((c) =>
    fs.existsSync(c),
  )
  const aJournal = Boolean(journal)

  let extrait = null
  let modVu = false
  if (aJournal) {
    const texte = fs.readFileSync(journal, 'utf8')
    modVu = /VoyageLien|VoyageSonde/i.test(texte)
    // On ne garde que la fin : le debut d'un journal UE4SS est du bruit d'amorcage.
    extrait = texte.split(String.fromCharCode(10)).slice(-40).join(String.fromCharCode(10))
  }

  return {
    binaires: bin,
    accroches: accrocheActuelle(bin),
    pointsPossibles: POINTS_ACCROCHE,
    ue4ssCharge: aJournal,
    journalDate: aJournal ? fs.statSync(journal).mtime.toISOString() : null,
    modVu,
    rapportPresent: Boolean(rapport),
    rapport: rapport ? fs.readFileSync(rapport, 'utf8').slice(0, 20000) : null,
    extraitJournal: extrait,
  }
}

function lancerJeu(dossierJeu) {
  // Par Steam : la surcouche, les succes et le temps de jeu restent corrects.
  execFile('cmd', ['/c', 'start', '', `steam://rungameid/${APPID}`], { windowsHide: true }, () => {})
}

module.exports = {
  APPID,
  POINTS_ACCROCHE,
  accrocheActuelle,
  signalerAilleurs,
  changerAccroche,
  diagnostiquer,
  NOM_JEU,
  trouverJeu,
  dossierBinaires,
  executableJeu,
  etat,
  installer,
  desinstaller,
  lancerJeu,
}
