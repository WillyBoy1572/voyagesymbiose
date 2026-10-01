'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TRANSPORT — par quel chemin les paquets passent, et pourquoi pas les autres
 * ═══════════════════════════════════════════════════════════════════════════
 *  Le brief demande de ne pas enfermer le projet dans l'UDP brut et de choisir
 *  automatiquement le meilleur chemin. Pour choisir, il faut d'abord savoir ce
 *  qui est reellement disponible — pas ce qu'on aimerait avoir.
 *
 *  ⚠️ CE FICHIER NE SIMULE AUCUN TRANSPORT. Chaque entree dit « disponible »
 *     ou « indisponible, parce que… ». Un transport Steam qui repondrait
 *     « disponible » sans App ID serait exactement la fausse fonctionnalite
 *     que le brief interdit.
 *
 *  ⚠️ LE MUR DE STEAM N'EST PAS TECHNIQUE, IL EST ADMINISTRATIF. Steam
 *     Networking, les lobbies, les invitations et le relais SDR passent tous
 *     par le Steamworks SDK, qui exige un App ID attribue a une application.
 *     Le mod n'en a pas ; utiliser celui de l'editeur du jeu serait se servir
 *     de son identite sans accord. Aucune quantite de code ne contourne ca.
 *
 *  ⚠️ GAMENETWORKINGSOCKETS EST POSSIBLE, MAIS PAS GRATUIT. La bibliotheque
 *     de Valve existe en open source (BSD), sans le relais. Elle apporterait
 *     chiffrement, fiabilite et controle de congestion — au prix d'un module
 *     natif, donc de la fin du « zero dependance » et d'une compilation par
 *     plateforme.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Les chemins envisages, du plus souhaitable au moins.
 *
 * `etat` vaut `'actif'`, `'possible'` ou `'impossible'`.
 */
const CHEMINS = [
  {
    cle: 'udp',
    nom: 'UDP direct',
    etat: 'actif',
    pourquoi:
      'En place et utilise. Aucune dependance. Demande un serveur joignable : pas de traversee de NAT.',
    chiffre: false,
    fiable: false,
    relais: false,
  },
  {
    cle: 'hebergement',
    nom: 'Hebergement Symbiose',
    etat: 'actif',
    pourquoi:
      'Serveurs publics joignables depuis Internet. C’est aujourd’hui le seul chemin fiable pour des joueurs derriere des box domestiques.',
    chiffre: false,
    fiable: false,
    relais: true,
  },
  {
    cle: 'gns',
    nom: 'GameNetworkingSockets',
    etat: 'possible',
    pourquoi:
      'Open source (BSD), sans le relais de Valve. Apporterait chiffrement, fiabilite et controle de congestion. Exige un module natif : fin du zero dependance, et une compilation par plateforme.',
    chiffre: true,
    fiable: true,
    relais: false,
  },
  {
    cle: 'steam-p2p',
    nom: 'Steam P2P (ISteamNetworkingSockets)',
    etat: 'impossible',
    pourquoi:
      'Exige le Steamworks SDK et un App ID attribue. Le mod n’en a pas, et s’appuyer sur celui de l’editeur du jeu serait utiliser son identite sans accord.',
    chiffre: true,
    fiable: true,
    relais: false,
  },
  {
    cle: 'steam-lobby',
    nom: 'Lobbies et invitations Steam',
    etat: 'impossible',
    pourquoi: 'Meme mur que Steam P2P : l’App ID.',
    chiffre: true,
    fiable: true,
    relais: false,
  },
  {
    cle: 'steam-sdr',
    nom: 'Steam Datagram Relay',
    etat: 'impossible',
    pourquoi:
      'Le reseau relaye de Valve est reserve aux applications partenaires. La version open source de la bibliotheque n’y donne pas acces.',
    chiffre: true,
    fiable: true,
    relais: true,
  },
]

/**
 * Le chemin retenu, et la raison.
 *
 * ⚠️ LE CHOIX EST TRIVIAL AUJOURD'HUI — un seul chemin est actif. La fonction
 *    existe pour que le jour ou un deuxieme apparaisse, la decision soit
 *    ecrite a un seul endroit, et pas eparpillee dans le serveur.
 */
function choisir() {
  const actifs = CHEMINS.filter((c) => c.etat === 'actif')
  const retenu = actifs[0] || null
  return {
    retenu: retenu ? retenu.cle : null,
    nom: retenu ? retenu.nom : 'aucun',
    pourquoi: retenu ? retenu.pourquoi : 'aucun transport disponible',
    ecartes: CHEMINS.filter((c) => c !== retenu).map((c) => ({
      cle: c.cle,
      nom: c.nom,
      etat: c.etat,
      pourquoi: c.pourquoi,
    })),
  }
}

/** Ce que le navigateur de serveurs et le diagnostic affichent. */
function rapport() {
  const c = choisir()
  return {
    transport: c.retenu,
    nom: c.nom,
    chiffre: false,
    fiable: false,
    chemins: CHEMINS.map((x) => ({ cle: x.cle, nom: x.nom, etat: x.etat, pourquoi: x.pourquoi })),
  }
}

module.exports = { choisir, rapport }
