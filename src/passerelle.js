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
  envoyerChat: (texte, canal) => ipcRenderer.invoke('chat:envoyer', texte, canal),
  envoyerCommande: (texte) => ipcRenderer.invoke('commande:envoyer', texte),
  serveurs: () => ipcRenderer.invoke('serveurs:liste'),
  detailServeur: (hote, port) => ipcRenderer.invoke('serveurs:detail', hote, port),

  // ── Coffre commun ──────────────────────────────────────────
  deposerAuCoffre: (nom, nombre) => ipcRenderer.invoke('coffre:deposer', nom, nombre),
  retirerDuCoffre: (nom, nombre) => ipcRenderer.invoke('coffre:retirer', nom, nombre),

  // ── Identite ───────────────────────────────────────────────
  /*
    ⚠️ LA CLE PRIVEE N'EST PAS ICI, ET ELLE NE PEUT PAS L'ETRE. Ces deux
       fonctions ne rendent que l'empreinte : c'est elle que l'hote d'un serveur
       inscrit dans `PROPRIETAIRES`, et elle ne permet rien a elle seule.
  */
  // ── Mises a jour, soutien, administration a distance ─────────────────────
  /*
    ⚠️ LA PAGE NE DETIENT AUCUNE CLE. Elle demande « les joueurs du serveur X » ;
       c'est le processus principal qui ajoute la cle d'administration a la
       requete. Une page web qui detiendrait des cles est une page web qui peut
       les perdre.
  */
  verifierMaj: () => ipcRenderer.invoke('maj:lanceur'),
  versionDuJeu: (dossier) => ipcRenderer.invoke('maj:jeu', dossier),
  packDeSoutien: (dossier) => ipcRenderer.invoke('soutien:fabriquer', dossier),

  poserCleAdmin: (hote, port, cle) => ipcRenderer.invoke('admin:poserCle', hote, port, cle),
  serveursAdministrables: () => ipcRenderer.invoke('admin:configures'),
  adminJoueurs: (hote, port) => ipcRenderer.invoke('admin:joueurs', hote, port),
  adminEtat: (hote, port) => ipcRenderer.invoke('admin:etat', hote, port),
  adminCommande: (hote, port, texte) => ipcRenderer.invoke('admin:commande', hote, port, texte),
  adminAnnoncer: (hote, port, texte) => ipcRenderer.invoke('admin:annoncer', hote, port, texte),

  /*
    ⚠️ ON NE REJOINT JAMAIS TOUT SEUL. Un lien `voyage://` PROPOSE ; c'est le
       joueur qui accepte. Un lanceur qui se connecte au clic d'un lien est un
       lanceur qu'on peut telecommander.
  */
  surInvitation: (rappel) => {
    ipcRenderer.removeAllListeners('invitation')
    ipcRenderer.on('invitation', (_e, i) => {
      if (!i || typeof i !== 'object') return
      rappel({
        hote: typeof i.hote === 'string' ? i.hote : null,
        port: Number.isInteger(i.port) ? i.port : null,
        billet: typeof i.billet === 'string' ? i.billet : null,
        protege: i.protege === true,
      })
    })
  },

  identite: () => ipcRenderer.invoke('identite:lire'),
  regenererIdentite: () => ipcRenderer.invoke('identite:regenerer'),

  // ── Héberger depuis chez soi ────────────────────────────────────
  /*
    ⚠️ LA PAGE NE LANCE PAS DE PROCESSUS. Elle demande, le processus principal
       decide : c'est lui qui connait le chemin du serveur embarqué, les secrets
       et le dossier de données. Une page web qui pourrait démarrer un
       programme n'aurait plus de limite.
  */
  etatHebergement: () => ipcRenderer.invoke('heberger:etat'),
  demarrerHebergement: (reglages) => ipcRenderer.invoke('heberger:demarrer', reglages),
  arreterHebergement: () => ipcRenderer.invoke('heberger:arreter'),
  commandeHebergement: (texte) => ipcRenderer.invoke('heberger:commande', texte),
  joueursHeberges: () => ipcRenderer.invoke('heberger:joueurs'),

  surLigneHebergement: (rappel) => {
    ipcRenderer.removeAllListeners('heberger:ligne')
    ipcRenderer.on('heberger:ligne', (_e, ligne) => {
      if (typeof ligne === 'string') return rappel(ligne)
      if (ligne && typeof ligne === 'object') {
        return rappel({
          heure: typeof ligne.heure === 'string' ? ligne.heure : '',
          cle: typeof ligne.cle === 'string' ? ligne.cle : '',
          valeurs: ligne.valeurs && typeof ligne.valeurs === 'object' ? ligne.valeurs : undefined,
        })
      }
    })
  },
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
  changerCreatures: (mode) => ipcRenderer.invoke('reglages:creatures', mode),
  changerPlaques: (options) => ipcRenderer.invoke('reglages:plaques', options),
  changerDebug: (actif) => ipcRenderer.invoke('reglages:debug', actif),
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
  connecter: (hote, port, motDePasse, billet) =>
    ipcRenderer.invoke('lien:connecter', hote, port, motDePasse, billet),
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

  /*
    ⚠️ ON NE PASSE PAS LA LIGNE PAR `String()`. Le lien envoie deux formes : du
       texte deja ecrit (il vient du pont, deja traduit) ou un objet
       `{heure, cle, valeurs}` que la page traduit elle-meme. `String()` sur le
       second rendait « [object Object] » dans le journal en direct -- et seule
       la relecture complete de l'etat affichait la vraie phrase, ce qui rendait
       le defaut difficile a voir.

    ⚠️ ON NE LAISSE PASSER QUE LES DEUX FORMES ATTENDUES. Une page ne doit pas
       recevoir un objet arbitraire venu du processus principal.
  */
  surLigneDuLien: (rappel) => {
    ipcRenderer.removeAllListeners('lien:ligne')
    ipcRenderer.on('lien:ligne', (_e, ligne) => {
      if (typeof ligne === 'string') return rappel(ligne)
      if (ligne && typeof ligne === 'object') {
        return rappel({
          heure: typeof ligne.heure === 'string' ? ligne.heure : '',
          cle: typeof ligne.cle === 'string' ? ligne.cle : '',
          valeurs: ligne.valeurs && typeof ligne.valeurs === 'object' ? ligne.valeurs : undefined,
        })
      }
    })
  },
})
