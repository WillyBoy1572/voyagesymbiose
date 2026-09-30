'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const jeu = require('./jeu')
const serveurs = require('./serveurs')
const lien = require('./lien')
const ue4ss = require('./ue4ss')
const sauvegardes = require('./sauvegardes')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LANCEUR VOYAGE — processus principal
 * ═══════════════════════════════════════════════════════════════════════════
 *  ⚠️ L'INTERFACE N'A AUCUN ACCES AU SYSTEME. `contextIsolation` actif,
 *     `nodeIntegration` eteint, et une passerelle etroite dans `pont.js` :
 *     la page ne peut appeler que les quelques fonctions declarees ici.
 *     Un lanceur qui installe des fichiers dans un jeu ne doit pas offrir
 *     `require` a une page web.
 *
 *  ⚠️ AUCUN CONTENU DISTANT N'EST CHARGE. Tout vient du disque ; les seules
 *     requetes reseau sont les interrogations de serveurs, faites ici.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const RACINE = path.join(__dirname, '..')
/** Nos mods, livres avec le lanceur. */
const DOSSIER_MODS = path.join(RACINE, 'mods')

let fenetre = null

function creerFenetre() {
  fenetre = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 620,
    backgroundColor: '#080c10',
    show: false,
    autoHideMenuBar: true,
    title: 'Voyage — Lanceur Symbiose',
    webPreferences: {
      preload: path.join(__dirname, 'passerelle.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  fenetre.loadFile(path.join(RACINE, 'ui', 'index.html'))

  /*
    ⚠️ LE JOURNAL DU PONT REMONTE EN DIRECT. Sans ca le joueur ne saurait
       pas si sa position part vraiment, et « ca marche pas » serait sa
       seule information.
  */
  lien.surLigne((ligne) => {
    if (fenetre && !fenetre.isDestroyed()) fenetre.webContents.send('lien:ligne', ligne)
  })
  fenetre.once('ready-to-show', () => fenetre.show())

  // Un lien externe s'ouvre dans le navigateur, jamais dans le lanceur.
  fenetre.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  creerFenetre()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) creerFenetre()
  })
})

  /*
    ⚠️ LE JEU DEMANDE, LE LANCEUR DECIDE. Une touche pressee en partie ne
       doit jamais ecraser des sauvegardes toute seule : le lanceur fait sa
       copie de securite, verifie l'archive, et repond par un fichier que le
       mod affiche a l'ecran.
  */
  lien.surCommande(async (commande) => {
    const repondreAuJeu = (ton, texte) => {
      try {
        fs.writeFileSync(path.join(os.tmpdir(), 'voyage-message.txt'), `${ton} ${texte}`, 'utf8')
      } catch {
        /* le jeu s'en passera */
      }
    }

    const cible = lien.cibleComplete()
    if (!cible) return repondreAuJeu('erreur', 'le pont n’est pas connecté.')

    if (commande === 'installer-monde') {
      try {
        repondreAuJeu('info', 'installation en cours…')
        const r = await sauvegardes.installer({
          hote: cible.hote,
          port: cible.port,
          motDePasse: cible.motDePasse ?? '',
          dossier: lireReglages().dossierSauvegardes,
        })
        repondreAuJeu(
          'bon',
          `${r.poses} fichier(s) installe(s). Retourne au menu et charge « ${r.etiquette || r.nom} ».`,
        )
        if (fenetre && !fenetre.isDestroyed()) fenetre.webContents.send('monde:change')
      } catch (e) {
        repondreAuJeu('erreur', e.message)
      }
      return
    }

    if (commande === 'publier-monde') {
      /*
        ⚠️ PUBLIER DEMANDE UN MOT DE PASSE QU'ON NE GARDE PAS. On ne peut donc
           pas le faire depuis le jeu sans le demander : on montre la fenetre
           du lanceur plutot que d'echouer en silence.
      */
      repondreAuJeu('info', 'le lanceur s’ouvre : onglet Monde, bouton Publier.')
      if (fenetre && !fenetre.isDestroyed()) {
        fenetre.show()
        fenetre.focus()
        fenetre.webContents.send('aller-a', 'monde')
      }
    }
  })

app.on('window-all-closed', () => app.quit())

// On ne laisse jamais un pont tourner apres la fermeture du lanceur.
app.on('before-quit', () => lien.nettoyer())

// ── Passerelle ──────────────────────────────────────────────────────────────

/** Enveloppe toute reponse : l'interface ne voit jamais une exception brute. */
function repondre(f) {
  return async (...args) => {
    try {
      return { ok: true, donnees: await f(...args) }
    } catch (e) {
      /*
        ⚠️ ON REMONTE LA CLE, PAS SEULEMENT LA PHRASE. La page choisit la
           langue ; le message francais ne sert que de filet quand une cle
           manque encore.
      */
      return {
        ok: false,
        erreur: e instanceof Error ? e.message : String(e),
        cle: e?.cle ?? null,
        valeurs: e?.valeurs ?? null,
      }
    }
  }
}

ipcMain.handle(
  'jeu:etat',
  repondre(async () => {
    const trouve = await jeu.trouverJeu()
    const memorise = lireReglages().dossierJeu
    const dossier = trouve?.dossier ?? (memorise && fs.existsSync(memorise) ? memorise : null)
    if (!dossier) return { trouve: false }
    return { trouve: true, dossier, source: trouve?.source ?? 'choisi à la main', ...jeu.etat(dossier) }
  }),
)

ipcMain.handle(
  'jeu:choisir',
  repondre(async () => {
    const r = await dialog.showOpenDialog(fenetre, {
      title: 'Où est installé The Last Caretaker ?',
      properties: ['openDirectory'],
    })
    if (r.canceled || !r.filePaths[0]) return { annule: true }
    const dossier = r.filePaths[0]
    if (!jeu.dossierBinaires(dossier)) {
      throw Object.assign(new Error('Ce dossier ne contient pas Binaries/Win64.'), { cle: 'err.pasBinaires' })
    }
    ecrireReglages({ ...lireReglages(), dossierJeu: dossier })
    return { dossier, ...jeu.etat(dossier) }
  }),
)

ipcMain.handle(
  'ue4ss:choisir',
  repondre(async () => {
    const r = await dialog.showOpenDialog(fenetre, {
      title: 'Dossier UE4SS extrait (celui qui contient dwmapi.dll)',
      properties: ['openDirectory'],
    })
    if (r.canceled || !r.filePaths[0]) return { annule: true }
    const dossier = r.filePaths[0]
    if (!fs.existsSync(path.join(dossier, 'dwmapi.dll'))) {
      throw Object.assign(new Error('dwmapi.dll est introuvable ici.'), { cle: 'err.pasDwmapi' })
    }
    ecrireReglages({ ...lireReglages(), dossierUe4ss: dossier })
    return { dossier }
  }),
)

ipcMain.handle(
  'installer',
  repondre(async (_e, dossierJeu) => {
    const reglages = lireReglages()
    if (!reglages.dossierUe4ss) throw Object.assign(new Error('Indique d’abord où tu as extrait UE4SS.'), { cle: 'err.indiqueUe4ss' })
    const journal = jeu.installer({
      dossierJeu,
      sourceUe4ss: reglages.dossierUe4ss,
      sourceMods: DOSSIER_MODS,
    })
    return { journal, ...jeu.etat(dossierJeu) }
  }),
)

ipcMain.handle(
  'desinstaller',
  repondre(async (_e, dossierJeu) => ({ journal: jeu.desinstaller(dossierJeu), ...jeu.etat(dossierJeu) })),
)

ipcMain.handle('jouer', repondre(async (_e, dossierJeu) => jeu.lancerJeu(dossierJeu)))

ipcMain.handle('serveurs:liste', repondre(async () => serveurs.rafraichir()))
ipcMain.handle('serveurs:ajouter', repondre(async (_e, adresse) => serveurs.ajouter(adresse)))
ipcMain.handle('serveurs:retirer', repondre(async (_e, hote, port) => serveurs.retirer(hote, port)))

// ── UE4SS : on va le chercher nous-memes ────────────────────────────────────

function annoncer(canal, charge) {
  if (fenetre && !fenetre.isDestroyed()) fenetre.webContents.send(canal, charge)
}

/**
 * Telecharge UE4SS et retient ou il a atterri.
 *
 * ⚠️ ON N'ECRASE PAS UN DOSSIER CHOISI A LA MAIN SANS LE DIRE : le nouveau
 *    chemin remplace l'ancien dans les reglages, et le journal l'annonce.
 */
async function obtenirUe4ss() {
  const r = await ue4ss.telecharger(ue4ss.dossierTemporaire(), (fait, total) => {
    annoncer('tele:avancement', { fait, total, pourcent: total ? Math.round((fait / total) * 100) : 0 })
  })
  annoncer('tele:avancement', { fait: 1, total: 1, pourcent: 100, extraction: true })
  ecrireReglages({ ...lireReglages(), dossierUe4ss: r.dossier, versionUe4ss: r.version })
  return r
}

ipcMain.handle('ue4ss:telecharger', repondre(async () => obtenirUe4ss()))

/**
 * Le bouton « Tout installer » : une seule action, du dossier vide au jeu pret.
 */
ipcMain.handle(
  'tout:installer',
  repondre(async (_e, dossierJeuDemande) => {
    const journal = []

    const trouve = await jeu.trouverJeu()
    const memorise = lireReglages().dossierJeu
    const dossierJeu =
      dossierJeuDemande || trouve?.dossier || (memorise && fs.existsSync(memorise) ? memorise : null)
    if (!dossierJeu) throw Object.assign(new Error('Le jeu est introuvable.'), { cle: 'err.jeuIntrouvable' })
    journal.push({ cle: 'jrn.jeuTrouve', valeurs: { dossier: dossierJeu } })

    /*
      ⚠️ ON RETELECHARGE SI LE DOSSIER MEMORISE A DISPARU. Il vit dans le
         dossier temporaire : Windows le vide, et un chemin mort donnerait
         une erreur incomprehensible au joueur.
    */
    let sourceUe4ss = lireReglages().dossierUe4ss
    if (!sourceUe4ss || !fs.existsSync(path.join(sourceUe4ss, 'dwmapi.dll'))) {
      const r = await obtenirUe4ss()
      sourceUe4ss = r.dossier
      journal.push({ cle: 'jrn.ue4ssTelecharge', valeurs: { version: r.version } })
    } else {
      journal.push({ cle: 'jrn.ue4ssDeja' })
    }

    journal.push(...jeu.installer({ dossierJeu, sourceUe4ss, sourceMods: DOSSIER_MODS }))

    const etat = jeu.etat(dossierJeu)
    if (!etat.ue4ss || !etat.mod) throw Object.assign(new Error('L’installation s’est terminée mais quelque chose manque.'), { cle: 'err.installIncomplete' })

    return { journal, dossier: dossierJeu, ...etat }
  }),
)

// ── Reste de la passerelle ──────────────────────────────────────────────────

ipcMain.handle(
  'reglages:langue',
  repondre(async (_e, langue) => {
    const propre = ['fr', 'en', 'es'].includes(langue) ? langue : 'fr'
    ecrireReglages({ ...lireReglages(), langue: propre })
    return { langue: propre }
  }),
)

ipcMain.handle('appli:version', repondre(async () => ({ version: app.getVersion() })))

ipcMain.handle(
  'dossier:ouvrir',
  repondre(async (_e, dossier) => {
    /*
      ⚠️ ON N'OUVRE QUE CE QU'ON CONNAIT. `shell.openPath` sur un chemin venu
         de la page ouvrirait n'importe quel dossier de la machine.
    */
    const reglages = lireReglages()
    const permis = [reglages.dossierJeu, reglages.dossierUe4ss].filter(Boolean)
    if (!permis.includes(dossier)) throw Object.assign(new Error('Dossier inconnu.'), { cle: 'err.dossierInconnu' })
    if (!fs.existsSync(dossier)) throw Object.assign(new Error('Ce dossier n’existe plus.'), { cle: 'err.dossierDisparu' })
    await shell.openPath(dossier)
    return { ouvert: dossier }
  }),
)


// ── Le monde : publier, regarder, installer, revenir ────────────────────────

/*
  ⚠️ LE MOT DE PASSE DU MONDE N'EST PAS CELUI DU SERVEUR. L'un laisse entrer
     dans la partie, l'autre autorise a REMPLACER la partie de tout le monde.
     Les melanger donnerait le second a quiconque a le premier.
*/
ipcMain.handle(
  'monde:local',
  repondre(async () => {
    const reglages = lireReglages()
    const dossier = sauvegardes.dossierSauvegardes(reglages.dossierSauvegardes)
    return {
      dossier,
      coffre: sauvegardes.dossierCoffre(),
      fichiers: sauvegardes.lister(dossier),
      copies: sauvegardes.copiesLocales(),
    }
  }),
)

ipcMain.handle(
  'monde:choisirDossier',
  repondre(async () => {
    const r = await dialog.showOpenDialog(fenetre, {
      title: 'Dossier SaveGames du jeu',
      properties: ['openDirectory'],
      defaultPath: sauvegardes.dossierSauvegardes() ?? undefined,
    })
    if (r.canceled || !r.filePaths[0]) return { annule: true }
    ecrireReglages({ ...lireReglages(), dossierSauvegardes: r.filePaths[0] })
    return { dossier: r.filePaths[0] }
  }),
)

ipcMain.handle(
  'monde:distant',
  repondre(async (_e, hote, port) => sauvegardes.infoDistante(hote, port)),
)

ipcMain.handle(
  'monde:publier',
  repondre(async (_e, hote, port, options) => {
    const reglages = lireReglages()
    return sauvegardes.publier({
      hote,
      port,
      motDePasseMonde: options?.motDePasseMonde ?? '',
      nom: options?.nom,
      etiquette: options?.etiquette,
      note: options?.note,
      par: (reglages.nomJoueur || '').trim() || 'hôte',
      dossier: reglages.dossierSauvegardes,
    })
  }),
)

ipcMain.handle(
  'monde:apercu',
  repondre(async (_e, hote, port, motDePasse) => {
    const vue = await sauvegardes.apercu({
      hote,
      port,
      motDePasse: motDePasse ?? '',
      dossier: lireReglages().dossierSauvegardes,
    })
    // L'archive reste sur disque pour l'installation ; l'interface n'en a pas besoin.
    const { archive, ...visible } = vue
    return visible
  }),
)

ipcMain.handle(
  'monde:installer',
  repondre(async (_e, hote, port, motDePasse) =>
    sauvegardes.installer({
      hote,
      port,
      motDePasse: motDePasse ?? '',
      dossier: lireReglages().dossierSauvegardes,
    }),
  ),
)

ipcMain.handle(
  'monde:restaurer',
  repondre(async (_e, chemin) => sauvegardes.restaurer(chemin, lireReglages().dossierSauvegardes)),
)

ipcMain.handle(
  'monde:mettreDeCote',
  repondre(async () => ({ copie: await sauvegardes.mettreDeCote(lireReglages().dossierSauvegardes) })),
)

ipcMain.handle(
  'lien:connecter',
  repondre(async (_e, hote, port, motDePasse) => {
    const reglages = lireReglages()
    const nom = (reglages.nomJoueur || '').trim() || 'Joueur'
    return lien.demarrer({ hote, port, nom, motDePasse, langue: reglages.langue || 'fr' })
  }),
)
ipcMain.handle('lien:deconnecter', repondre(async () => lien.arreter()))
ipcMain.handle('lien:etat', repondre(async () => lien.etat()))

ipcMain.handle(
  'reglages:nom',
  repondre(async (_e, nom) => {
    const propre = String(nom ?? '').replace(/[^\p{L}\p{N} _.\-]/gu, '').trim().slice(0, 24)
    if (!propre) throw Object.assign(new Error('Choisis un pseudo.'), { cle: 'err.pseudoVide' })
    ecrireReglages({ ...lireReglages(), nomJoueur: propre })
    return { nom: propre }
  }),
)

ipcMain.handle('diagnostic', repondre(async (_e, dossierJeu) => jeu.diagnostiquer(dossierJeu)))

ipcMain.handle(
  'accroche:changer',
  repondre(async (_e, dossierJeu, nom) => ({ nom: jeu.changerAccroche(dossierJeu, nom) })),
)

ipcMain.handle(
  'rapport:lire',
  repondre(async (_e, dossierJeu) => {
    const bin = jeu.dossierBinaires(dossierJeu)
    if (!bin) throw Object.assign(new Error('Binaires introuvables.'), { cle: 'err.binaires' })
    const chemin = path.join(bin, 'VoyageSonde.txt')
    if (!fs.existsSync(chemin)) {
      throw Object.assign(new Error('Pas encore de rapport.'), { cle: 'err.pasDeRapport' })
    }
    return { chemin, contenu: fs.readFileSync(chemin, 'utf8').slice(0, 20000) }
  }),
)

// ── Reglages du lanceur ─────────────────────────────────────────────────────

const FICHIER_REGLAGES = path.join(app.getPath('userData'), 'reglages.json')

function lireReglages() {
  try {
    return JSON.parse(fs.readFileSync(FICHIER_REGLAGES, 'utf8'))
  } catch {
    return {}
  }
}

function ecrireReglages(r) {
  fs.mkdirSync(path.dirname(FICHIER_REGLAGES), { recursive: true })
  fs.writeFileSync(FICHIER_REGLAGES, JSON.stringify(r, null, 1), 'utf8')
}

ipcMain.handle('reglages:lire', repondre(async () => lireReglages()))
