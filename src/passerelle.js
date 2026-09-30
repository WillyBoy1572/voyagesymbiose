'use strict'

const { contextBridge, ipcRenderer } = require('electron')

/**
 * La passerelle entre l'interface et le systeme.
 *
 * ⚠️ RIEN D'AUTRE QUE CETTE LISTE N'EST ACCESSIBLE DEPUIS LA PAGE. Pas de
 *    `require`, pas de `fs`, pas d'`ipcRenderer` brut : une page qui peut
 *    appeler n'importe quel canal IPC peut faire n'importe quoi au disque.
 *
 * ⚠️ ELLE S'APPELAIT `pont.js`. Le nom est parti pour `passerelle.js` le
 *    jour ou un vrai `pont/pont.js` est arrive — celui qui parle au jeu.
 *    Deux fichiers « pont » dans un meme projet finissent toujours par
 *    etre confondus.
 */
contextBridge.exposeInMainWorld('voyage', {
  etatJeu: () => ipcRenderer.invoke('jeu:etat'),
  choisirJeu: () => ipcRenderer.invoke('jeu:choisir'),
  choisirUe4ss: () => ipcRenderer.invoke('ue4ss:choisir'),
  installer: (dossier) => ipcRenderer.invoke('installer', dossier),
  desinstaller: (dossier) => ipcRenderer.invoke('desinstaller', dossier),
  jouer: (dossier) => ipcRenderer.invoke('jouer', dossier),
  serveurs: () => ipcRenderer.invoke('serveurs:liste'),
  ajouterServeur: (adresse) => ipcRenderer.invoke('serveurs:ajouter', adresse),
  retirerServeur: (hote, port) => ipcRenderer.invoke('serveurs:retirer', hote, port),
  rapport: (dossier) => ipcRenderer.invoke('rapport:lire', dossier),
  diagnostic: (dossier) => ipcRenderer.invoke('diagnostic', dossier),
  changerAccroche: (dossier, nom) => ipcRenderer.invoke('accroche:changer', dossier, nom),
  reglages: () => ipcRenderer.invoke('reglages:lire'),

  // ── Installation automatique ─────────────────────────────────────────────
  telechargerUe4ss: () => ipcRenderer.invoke('ue4ss:telecharger'),
  toutInstaller: (dossier) => ipcRenderer.invoke('tout:installer', dossier),
  surAvancement: (rappel) => {
    ipcRenderer.removeAllListeners('tele:avancement')
    ipcRenderer.on('tele:avancement', (_e, etat) => rappel(etat))
  },

  // ── Reglages ─────────────────────────────────────────────────────────────
  changerLangue: (langue) => ipcRenderer.invoke('reglages:langue', langue),
  version: () => ipcRenderer.invoke('appli:version'),
  ouvrirDossier: (dossier) => ipcRenderer.invoke('dossier:ouvrir', dossier),

  // ── Le monde ─────────────────────────────────────────────────────────────
  mondeLocal: () => ipcRenderer.invoke('monde:local'),
  choisirDossierSauvegardes: () => ipcRenderer.invoke('monde:choisirDossier'),
  mondeDistant: (hote, port) => ipcRenderer.invoke('monde:distant', hote, port),
  publierMonde: (hote, port, options) => ipcRenderer.invoke('monde:publier', hote, port, options),
  apercuMonde: (hote, port, motDePasse) => ipcRenderer.invoke('monde:apercu', hote, port, motDePasse),
  installerMonde: (hote, port, motDePasse) => ipcRenderer.invoke('monde:installer', hote, port, motDePasse),
  restaurerMonde: (chemin) => ipcRenderer.invoke('monde:restaurer', chemin),
  mettreDeCote: () => ipcRenderer.invoke('monde:mettreDeCote'),

  // ── Le lien avec le serveur ──────────────────────────────────────────────
  enregistrerNom: (nom) => ipcRenderer.invoke('reglages:nom', nom),
  connecter: (hote, port, motDePasse) => ipcRenderer.invoke('lien:connecter', hote, port, motDePasse),
  deconnecter: () => ipcRenderer.invoke('lien:deconnecter'),
  etatLien: () => ipcRenderer.invoke('lien:etat'),

  /*
    ⚠️ ON NE REND PAS `ipcRenderer.on` A LA PAGE. Elle ne recoit qu'un
       rappel, sur un seul canal, avec le texte deja extrait.
  */
  /** Le jeu peut demander au lanceur de montrer un onglet. */
  surDemandeDOnglet: (rappel) => {
    ipcRenderer.removeAllListeners('aller-a')
    ipcRenderer.on('aller-a', (_e, onglet) => rappel(String(onglet)))
  },

  surLigneDuLien: (rappel) => {
    ipcRenderer.removeAllListeners('lien:ligne')
    ipcRenderer.on('lien:ligne', (_e, ligne) => rappel(String(ligne)))
  },
})
