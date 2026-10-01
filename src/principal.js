'use strict'

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawn } = require('node:child_process')
const jeu = require('./jeu')
const serveurs = require('./serveurs')
const lien = require('./lien')
const ue4ss = require('./ue4ss')
const sauvegardes = require('./sauvegardes')
const identite = require('./identite')
const heberger = require('./heberger')
const maj = require('./maj')
const soutien = require('./soutien')
const administration = require('./administration')
const invitation = require('./invitation')

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

/*
  LES LIENS D'INVITATION `voyage://`.

  ⚠️ UNE SEULE INSTANCE, SINON LE LIEN OUVRE UN DEUXIEME LANCEUR. Windows lance
     un nouveau processus a chaque clic sur un lien : sans verrou, le joueur se
     retrouve avec deux lanceurs, deux ponts, et un tube nomme que le second ne
     peut pas ouvrir.

  ⚠️ LE LIEN NE PORTE JAMAIS DE MOT DE PASSE. Une URL se retrouve dans
     l'historique, dans les journaux d'un salon Discord, dans un presse-papiers
     partage. Il dit qu'un mot de passe est demande ; le lanceur le demande.
*/
const verrou = app.requestSingleInstanceLock()
if (!verrou) {
  app.quit()
}

/** Ce qu'un lien `voyage://` demande, en attendant que la page soit prete. */
let invitationEnAttente = null

/*
  ⚠️ LA LECTURE DES LIENS VIT DANS `invitation.js`, PAS ICI. C'est du code qui
     analyse une entrée venue de l'extérieur — un lien se clique sans réfléchir —
     et ce genre de code doit pouvoir être mis à l'épreuve hors d'Electron.
*/

function proposerInvitation(invitation) {
  if (!invitation) return
  if (fenetre && !fenetre.isDestroyed()) {
    fenetre.show()
    fenetre.focus()
    fenetre.webContents.send('invitation', invitation)
    invitationEnAttente = null
  } else {
    invitationEnAttente = invitation
  }
}

/*
  ⚠️ EN DEVELOPPEMENT, IL FAUT DONNER LE CHEMIN DE L'EXECUTABLE ET L'ARGUMENT.
     Sans ca, Windows enregistre `electron.exe` tout seul et le lien ouvre un
     Electron vide au lieu du lanceur.
*/
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('voyage', process.execPath, [path.resolve(process.argv[1])])
  }
} else {
  app.setAsDefaultProtocolClient('voyage')
}

app.on('second-instance', (_e, arguments_) => {
  proposerInvitation(invitation.dansLesArguments(arguments_))
  if (fenetre && !fenetre.isDestroyed()) {
    if (fenetre.isMinimized()) fenetre.restore()
    fenetre.show()
    fenetre.focus()
  }
})

// macOS passe les liens par cet evenement ; Windows par la ligne de commande.
app.on('open-url', (e, url) => {
  e.preventDefault()
  proposerInvitation(invitation.lire(url))
})
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

  /*
    ⚠️ LA CONSOLE DU SERVEUR HEBERGE REMONTE EN DIRECT, comme celle du pont.
       Sans elle, « mon serveur ne demarre pas » n'aurait aucune explication :
       le serveur dit pourtant precisement ce qui lui manque.
  */
  heberger.surLigne((ligne) => {
    if (fenetre && !fenetre.isDestroyed()) fenetre.webContents.send('heberger:ligne', ligne)
  })
  fenetre.once('ready-to-show', () => {
    fenetre.show()
    // Un lien cliqué avant que la fenêtre existe ne doit pas être perdu.
    if (invitationEnAttente) proposerInvitation(invitationEnAttente)
  })

  // Un lien externe s'ouvre dans le navigateur, jamais dans le lanceur.
  fenetre.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  /*
    ⚠️ LE LIEN RECOIT SON CONTEXTE AVANT TOUTE CONNEXION. Sans le dossier de
       donnees il ne peut pas signer, et le joueur entrerait en anonyme sans
       comprendre pourquoi son role a disparu.
  */
  lien.poserContexte({
    dossier: app.getPath('userData'),
    reprisesConnues: lireReglages().reprises,
  })
  heberger.poserContexte({ dossier: app.getPath('userData') })
  administration.poserContexte({ dossier: app.getPath('userData') })

  /*
    ⚠️ LE JETON DE REPRISE S'ECRIT SUR DISQUE, PARCE QUE LE VRAI CAS D'USAGE
       EST UN PLANTAGE. Garde seulement en memoire, il disparaitrait avec le
       lanceur -- c'est-a-dire exactement au moment ou il sert.
  */
  lien.surReprise((adresse, jeton) => {
    try {
      const r = lireReglages()
      r.reprises = { ...(r.reprises || {}), [adresse]: jeton }
      ecrireReglages(r)
    } catch {
      /* un jeton non enregistre ne fait perdre que la reprise */
    }
  })

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
app.on('before-quit', () => {
  lien.nettoyer()
  // Un serveur laisse derriere nous continuerait d'occuper le port, en silence.
  heberger.nettoyer()
})

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

/*
  Le chat part par l'entree standard du pont (voir lien.envoyerLigne).

  ⚠️ LE CANAL EST VERIFIE ICI, PAS DANS LA PAGE. La page est du HTML : ce
     qu'elle envoie n'est pas une garantie. Un canal inconnu devient « global »
     plutot que de produire une ligne que le pont ne saura pas lire.
*/
const CANAUX = { global: 'chat', local: 'chat-local', equipe: 'chat-equipe' }

ipcMain.handle('chat:envoyer', repondre(async (_e, texte, canal) => {
  const propre = String(texte || '').slice(0, 240).trim()
  if (!propre) return { ok: false }
  const mot = CANAUX[String(canal || 'global')] || 'chat'
  return { ok: lien.envoyerLigne(mot + ' ' + propre) }
}))

/*
  Une commande de serveur, tapee depuis le lanceur.

  ⚠️ LE LANCEUR N'INTERPRETE RIEN. C'est le serveur qui decide si la commande
     existe et si le joueur a le droit de la lancer ; le lanceur qui filtrerait
     lui-meme donnerait une liste a maintenir en deux endroits.
*/
ipcMain.handle('commande:envoyer', repondre(async (_e, texte) => {
  const propre = String(texte || '').slice(0, 240).trim()
  if (!propre) return { ok: false }
  return { ok: lien.envoyerLigne('commande ' + propre) }
}))

/*
  Le coffre commun.

  ⚠️ C'EST LE SEUL ECHANGE D'OBJETS REELLEMENT POSSIBLE. Chaque joueur charge
     SA sauvegarde, avec SES objets : rien dans le jeu ne relie son sac a celui
     d'un autre. Le coffre est tenu par le serveur, et c'est lui qui debite
     avant que quiconque recoive -- sinon un paquet perdu dupliquerait l'objet.
*/
ipcMain.handle('coffre:deposer', repondre(async (_e, nom, nombre) => {
  const propre = String(nom || '').slice(0, 48).trim()
  const combien = Math.max(1, Math.min(Number.parseInt(nombre, 10) || 1, 10000))
  if (!propre) return { ok: false }
  return { ok: lien.envoyerLigne(`deposer ${combien} ${propre}`) }
}))

ipcMain.handle('coffre:retirer', repondre(async (_e, nom, nombre) => {
  const propre = String(nom || '').slice(0, 48).trim()
  const combien = Math.max(1, Math.min(Number.parseInt(nombre, 10) || 1, 10000))
  if (!propre) return { ok: false }
  return { ok: lien.envoyerLigne(`retirer ${combien} ${propre}`) }
}))

/*
  L'identite du joueur.

  ⚠️ LA CLE PRIVEE NE SORT JAMAIS D'ICI. On ne rend que l'empreinte : c'est
     elle que l'hote d'un serveur inscrit dans `PROPRIETAIRES`, et elle ne
     permet rien a elle seule.
*/
ipcMain.handle('identite:lire', repondre(async () => identite.publique(app.getPath('userData'))))

/*
  ⚠️ REGENERER PERD TOUT : roles, profil, heures de jeu sont attaches a
     l'ancienne empreinte. L'ancienne cle est mise de cote, pas effacee -- une
     identite perdue ne se retrouve pas, et un clic ne doit pas pouvoir la
     detruire. C'est la page qui demande confirmation.
*/
ipcMain.handle('identite:regenerer', repondre(async () => identite.regenerer(app.getPath('userData'))))

ipcMain.handle('serveurs:liste', repondre(async () => serveurs.rafraichir()))

/*
  Le detail d'un serveur : joueurs, equipes, activites, coffre, mesures.

  ⚠️ TOUT PASSE PAR LE PORT TCP PUBLIC, QUI NE REND AUCUN SECRET. Pas
     d'adresse de joueur, pas d'empreinte, pas de jeton : exactement ce qu'on
     accepterait d'afficher sur un site.

  ⚠️ UNE ROUTE QUI NE REPOND PAS N'EST PAS UNE PANNE. Un serveur plus ancien
     n'a pas `/equipes` ni `/mesures` : on rend `null` pour cette partie et on
     affiche le reste, plutot que de declarer le serveur injoignable.
*/
ipcMain.handle(
  'serveurs:detail',
  repondre(async (_e, hote, port) => {
    const base = `http://${hote}:${Number(port) + 1}`
    const lire = async (chemin) => {
      try {
        const r = await fetch(base + chemin, { signal: AbortSignal.timeout(2500) })
        if (!r.ok) return null
        return await r.json()
      } catch {
        return null
      }
    }
    const [info, joueurs, equipes, activites, coffre, mesures] = await Promise.all([
      lire('/info'),
      lire('/joueurs'),
      lire('/equipes'),
      lire('/activites'),
      lire('/coffre'),
      lire('/mesures'),
    ])
    return { info, joueurs, equipes, activites, coffre, mesures }
  }),
)
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
  repondre(async (_e, hote, port, motDePasse, billet) => {
    const reglages = lireReglages()
    const nom = (reglages.nomJoueur || '').trim() || 'Joueur'
    /*
      ⚠️ LE BILLET SE RESOUT DEPUIS LA PRISE DU PONT, PAS D'ICI. Le percage
         ouvre un chemin vers la prise QUI A DEMANDE : resoudre le billet dans
         le processus principal donnerait une adresse joignable par le lanceur
         et par personne d'autre. C'est le pont qui parle au rendez-vous.
    */
    const b = String(billet ?? '').trim().toUpperCase()
    const rendezvous = b
      ? String(lireReglages().rendezvous || heberger.RENDEZVOUS_PAR_DEFAUT)
      : ''
    return lien.demarrer({
      hote,
      port,
      billet: b,
      rendezvous,
      nom,
      motDePasse,
      langue: reglages.langue || 'fr',
      creatures: reglages.creatures || 'miroir',
      plaques: reglages.plaques,
      debug: reglages.debug === true,
    })
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

// ── Mises a jour ────────────────────────────────────────────────────────────

/*
  ⚠️ ON REGARDE, ON NE TELECHARGE PAS. Un lanceur qui remplace son propre
     executable pendant qu'une partie tourne est une mauvaise idee ; un lanceur
     qui installe sans demander en est une pire.
*/
ipcMain.handle('maj:lanceur', repondre(async () => maj.verifierLanceur(app.getVersion())))

/** Le fichier telecharge, verifie, pret a etre lance. `null` tant qu'il n'y en a pas. */
let installeurPret = null

ipcMain.handle(
  'maj:telecharger',
  repondre(async () => {
    const r = await maj.verifierLanceur(app.getVersion())
    if (r.aJour !== false) {
      throw Object.assign(new Error('rien \u00e0 installer'), { cle: 'err.majRien' })
    }
    const t = await maj.telechargerLanceur(r, (fait, total) => {
      annoncer('maj:avancement', {
        fait,
        total,
        pourcent: total ? Math.round((fait / total) * 100) : 0,
      })
    })
    installeurPret = t.chemin
    return { ...t, version: r.versionDistante }
  }),
)

/**
 * Lance l'installeur et ferme le lanceur.
 *
 * ⚠️ ON NE FERME PAS SANS QUE LE JOUEUR L'AIT DEMANDE. L'installeur remplace
 *    les fichiers de l'application : il ne peut pas travailler pendant qu'elle
 *    tourne. Fermer tout seul pendant une partie serait exactement le genre de
 *    chose qu'on reproche aux autres lanceurs -- d'ou le bouton, et d'ou le
 *    refus quand un serveur heberge ici tourne encore.
 */
ipcMain.handle(
  'maj:installer',
  repondre(async () => {
    if (!installeurPret || !fs.existsSync(installeurPret)) {
      throw Object.assign(new Error('rien de pr\u00eat'), { cle: 'err.majPasPret' })
    }
    if (heberger.actif()) {
      throw Object.assign(new Error('un serveur tourne'), { cle: 'err.majServeurEnMarche' })
    }
    const enfant = spawn(installeurPret, [], { detached: true, stdio: 'ignore' })
    enfant.unref()
    setTimeout(() => app.quit(), 500)
    return { lance: true }
  }),
)

/*
  Le jeu a-t-il change sous nos pieds ?

  ⚠️ ON RETIENT LE BUILD VU LA DERNIERE FOIS. Steam met a jour en silence : une
     classe renommee et le mod se tait, sans la moindre erreur. C'est le pire
     des echecs, celui qui ressemble a un bogue de chez le joueur.
*/
ipcMain.handle(
  'maj:jeu',
  repondre(async (_e, dossierJeu) => {
    const actuel = maj.versionDuJeu(dossierJeu)
    const r = lireReglages()
    const verdict = maj.jeuAChange(actuel, r.jeuVu)
    if (actuel && actuel.build && actuel.build !== r.jeuVu?.build) {
      r.jeuVu = actuel
      ecrireReglages(r)
    }
    return { ...verdict, actuel }
  }),
)

// ── Pack de soutien ─────────────────────────────────────────────────────────

ipcMain.handle(
  'soutien:fabriquer',
  repondre(async (_e, dossierJeu) => {
    const r = lireReglages()
    const etatH = heberger.etat()

    // Ce que le serveur hebergé dit de lui-meme, s'il tourne.
    let serveur = null
    const a = heberger.adresseAdmin()
    if (a) {
      try {
        const e = await fetch(`${a.base}/admin/etat`, {
          headers: { 'X-Admin-Cle': a.cle },
          signal: AbortSignal.timeout(2500),
        })
        if (e.ok) serveur = await e.json()
      } catch {
        /* le serveur ne repond pas : le pack le dira */
      }
    }

    return soutien.fabriquer({
      dossier: app.getPath('desktop'),
      versionLanceur: app.getVersion(),
      versionJeu: maj.versionDuJeu(dossierJeu),
      dossierJeu,
      etatJeu: dossierJeu ? await jeu.diagnostiquer(dossierJeu).catch(() => null) : null,
      identite: identite.publique(app.getPath('userData')),
      lien: lien.etat(),
      hebergement: etatH,
      serveur,
      maj: await maj.verifierLanceur(app.getVersion()),
      reglages: { langue: r.langue },
    })
  }),
)

// ── Administration a distance ───────────────────────────────────────────────

/*
  ⚠️ LES CLES NE SORTENT JAMAIS DU PROCESSUS PRINCIPAL. La page demande « les
     joueurs du serveur X » ; c'est ici que la cle est ajoutee a la requete.
*/
ipcMain.handle(
  'admin:poserCle',
  repondre(async (_e, hote, port, cle) => administration.poserCle(hote, port, cle)),
)
ipcMain.handle('admin:configures', repondre(async () => administration.serveursConfigures()))
ipcMain.handle('admin:joueurs', repondre(async (_e, hote, port) => administration.joueurs(hote, port)))
ipcMain.handle('admin:etat', repondre(async (_e, hote, port) => administration.etat(hote, port)))
ipcMain.handle('admin:sanctions', repondre(async (_e, hote, port) => administration.sanctions(hote, port)))
ipcMain.handle(
  'admin:commande',
  repondre(async (_e, hote, port, texte) => administration.commande(hote, port, texte)),
)
ipcMain.handle(
  'admin:annoncer',
  repondre(async (_e, hote, port, texte) => administration.annoncer(hote, port, texte)),
)

// ── Hebergement maison ──────────────────────────────────────────────────────

/*
  ⚠️ C'EST LA SEULE FACON D'HEBERGER AVEC SA PROPRE PARTIE. Sur un serveur loue,
     publier un monde demande le mot de passe de publication, que seul celui qui
     tient l'hebergement possede. Ici le lanceur ecrit l'archive directement dans
     le dossier du serveur, avant qu'il demarre.
*/
/*
  Le mode des creatures, garde d'une fois sur l'autre.

  ⚠️ C'EST UN REGLAGE DE CLIENT, PAS DE SERVEUR. Il ne part pas sur le reseau :
     il decide seulement de ce que CE joueur voit.
*/
ipcMain.handle(
  'reglages:creatures',
  repondre(async (_e, mode) => {
    const propre = ['miroir', 'annonce', 'rien'].includes(mode) ? mode : 'miroir'
    const r = lireReglages()
    r.creatures = propre
    ecrireReglages(r)
    return { creatures: propre }
  }),
)

/*
  Les plaques de nom et le mode debug : des choix d'affichage, pas de serveur.

  ⚠️ ILS NE PARTENT PAS SUR LE RESEAU. Ce qu'un joueur affiche au-dessus des
     tetes ne regarde que lui ; le serveur n'en connait pas un mot.
*/
ipcMain.handle(
  'reglages:plaques',
  repondre(async (_e, options) => {
    const r = lireReglages()
    const o = options && typeof options === 'object' ? options : {}
    r.plaques = {
      noms: o.noms !== false,
      distance: o.distance !== false,
      ping: o.ping === true,
      vie: o.vie === true,
      portee: Math.min(Math.max(Number.parseInt(o.portee, 10) || 80, 5), 500),
    }
    ecrireReglages(r)
    return r.plaques
  }),
)

ipcMain.handle(
  'reglages:debug',
  repondre(async (_e, actif) => {
    const r = lireReglages()
    r.debug = actif === true
    ecrireReglages(r)
    return { debug: r.debug }
  }),
)

ipcMain.handle('heberger:etat', repondre(async () => heberger.etat()))

ipcMain.handle(
  'heberger:demarrer',
  repondre(async (_e, reglages) => {
    const r = lireReglages()
    const moi = identite.publique(app.getPath('userData'))

    const etat = await heberger.demarrer({
      ...reglages,
      pseudo: (r.nomJoueur || '').trim() || 'hôte',
      // La console du serveur suit la langue choisie dans le lanceur.
      langue: r.langue || 'fr',
      dossierSauvegardes: r.dossierSauvegardes,
      empreinte: moi ? moi.empreinte : null,
    })

    // On garde les reglages d'hebergement d'une fois sur l'autre.
    r.hebergement = {
      nom: etat.reglages?.nom,
      port: etat.reglages?.port,
      maxJoueurs: etat.reglages?.maxJoueurs,
      public: etat.reglages?.public,
      motDePasse: reglages.motDePasse || '',
      partagerLaPartie: reglages.partagerLaPartie !== false,
      cycleMinutes: reglages.cycleMinutes || 0,
    }
    ecrireReglages(r)
    return etat
  }),
)

ipcMain.handle('heberger:arreter', repondre(async () => heberger.arreter()))

ipcMain.handle('heberger:commande', repondre(async (_e, texte) => ({ ok: heberger.commande(texte) })))

/*
  Qui est sur MON serveur, avec de quoi agir.

  ⚠️ CETTE ROUTE DONNE LES ADRESSES, ET ELLE EST RESERVEE A SON PROPRIETAIRE.
     Elle n'est interrogeable que sur 127.0.0.1, avec une cle que seul ce
     lanceur connait. L'hote en a besoin pour bannir ; personne d'autre.
*/
ipcMain.handle(
  'heberger:joueurs',
  repondre(async () => {
    const a = heberger.adresseAdmin()
    if (!a) return { joueurs: [], annuaire: null }
    try {
      const [joueurs, etat] = await Promise.all([
        fetch(`${a.base}/admin/joueurs`, {
          headers: { 'X-Admin-Cle': a.cle },
          signal: AbortSignal.timeout(2500),
        }).then((r) => (r.ok ? r.json() : null)),
        fetch(`${a.base}/admin/etat`, {
          headers: { 'X-Admin-Cle': a.cle },
          signal: AbortSignal.timeout(2500),
        }).then((r) => (r.ok ? r.json() : null)),
      ])
      return {
        joueurs: joueurs?.joueurs ?? [],
        annuaire: etat?.annuaire ?? null,
        mesures: etat?.mesures ?? null,
      }
    } catch {
      return { joueurs: [], annuaire: null }
    }
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
