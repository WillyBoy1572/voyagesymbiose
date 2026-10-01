'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PACK DE SOUTIEN — tout ce qu'il faut pour comprendre, et rien d'autre
 * ═══════════════════════════════════════════════════════════════════════════
 *  « Ça marche pas » ne se diagnostique pas. Un fichier qui rassemble versions,
 *  journaux, diagnostics et empreintes se diagnostique en une minute.
 *
 *  ⚠️ CE FICHIER SERA COLLÉ DANS DISCORD. C'est tout le point du format, et
 *     c'est aussi pourquoi il ne doit contenir AUCUN secret : mot de passe de
 *     serveur, mot de passe de monde, clé d'administration, jeton de reprise,
 *     clé privée d'identité. On expurge, et on dit qu'on a expurgé — un champ
 *     silencieusement absent fait croire à un bug de collecte.
 *
 *  ⚠️ L'EMPREINTE D'IDENTITÉ, ELLE, RESTE. Ce n'est pas un secret : c'est
 *     l'identifiant public du joueur, et c'est exactement ce qu'un hôte demande
 *     pour lui donner un rôle.
 *
 *  ⚠️ ON N'ENVOIE RIEN NULLE PART. Le pack est écrit sur le disque du joueur,
 *     il le lit, et c'est lui qui décide de le partager.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Combien de lignes de journal on garde par source. */
const LIGNES = 150

/** Les mots qui, dans une ligne, la rendent impubliable. */
/*
  ⚠️ LA LISTE SE LIT SUR UNE LIGNE MISE EN MINUSCULES, SANS SÉPARATEUR. Elle a
     déjà laissé passer trois choses, et toutes les trois pour la même raison :
     on avait écrit le mot tel qu'il apparaissait à UN endroit.

       « admin_cle »  n'attrape pas  « cleAdmin: a1b2c3 »
       « password »   n'attrape pas  « mdp du serveur : hunter2 »
       « secret »     n'attrape pas  « Authorization: Bearer eyJ… »

     On couvre donc les deux langues ET les deux écritures. Un mot de trop retire
     une ligne de journal : ça se remarque, et ça se demande. Un mot de moins
     publie un secret : ça ne se remarque jamais.
*/
const MOTS_SENSIBLES = [
  // Mots de passe, dans les deux langues et les deux écritures.
  'motdepasse',
  'mot de passe',
  'mdp',
  'password',
  'passwd',
  // Clés d'administration, quel que soit le sens d'écriture.
  'admin_cle',
  'admincle',
  'cleadmin',
  'cléadmin',
  'x-admin-cle',
  'monde_motdepasse',
  // Tout ce qui autorise une requête.
  'authorization',
  'bearer',
  'apikey',
  'api_key',
  'clé =',
  'cle =',
  'clé=',
  'cle=',
  // Jetons, signatures, clés privées.
  'reprise',
  'privee',
  'privée',
  'private',
  'secret',
  'jeton',
  'token',
  'signature',
  'sig=',
]

/**
 * Retire d'une ligne ce qui ne doit pas sortir de la machine.
 *
 * ⚠️ ON COUPE LA LIGNE ENTIÈRE, ON NE MASQUE PAS LE MOT. Masquer la valeur
 *    suppose qu'on sait où elle commence ; une ligne inattendue laisserait le
 *    secret passer. Une ligne manquante se remarque, un secret publié ne se
 *    reprend pas.
 */
function expurger(ligne) {
  const bas = String(ligne).toLowerCase()
  if (MOTS_SENSIBLES.some((m) => bas.includes(m))) return '[ligne retirée : contenait peut-être un secret]'
  return String(ligne)
}

function section(titre, lignes) {
  return ['', `── ${titre} ${'─'.repeat(Math.max(2, 60 - titre.length))}`, ...lignes].join('\n')
}

function dire(valeur) {
  if (valeur === null || valeur === undefined || valeur === '') return 'N/A'
  return String(valeur)
}

/**
 * Fabrique le pack. Rend `{ chemin, taille }`.
 *
 * Tout est fourni par l'appelant : ce module ne connaît ni Electron, ni le
 * réseau, ni le disque du jeu — il met en forme, il expurge, il écrit.
 */
function fabriquer({
  dossier,
  versionLanceur,
  versionJeu,
  dossierJeu,
  etatJeu,
  identite,
  lien,
  hebergement,
  serveur,
  maj,
  reglages,
}) {
  const maintenant = new Date()
  const morceaux = []

  morceaux.push('PACK DE SOUTIEN — SYMBIOSE VOYAGE')
  morceaux.push(`généré le ${maintenant.toISOString()}`)
  morceaux.push('')
  morceaux.push('Ce fichier peut être partagé : les lignes pouvant contenir un secret')
  morceaux.push('(mots de passe, clés, jetons) ont été retirées et remplacées par une mention.')

  morceaux.push(
    section('Versions', [
      `lanceur          ${dire(versionLanceur)}`,
      `serveur embarqué ${dire(serveur?.version)}`,
      `jeu (build Steam) ${dire(versionJeu?.build)}`,
      `jeu mis à jour le ${versionJeu?.misAJourLe ? new Date(versionJeu.misAJourLe).toISOString() : 'N/A'}`,
      `mise à jour du lanceur : ${
        maj?.aJour === null ? 'inconnue (' + dire(maj?.raison) + ')' : maj?.aJour ? 'à jour' : 'une version ' + dire(maj?.versionDistante) + ' existe'
      }`,
    ]),
  )

  morceaux.push(
    section('Machine', [
      `système     ${os.platform()} ${os.release()}`,
      `processeur  ${os.cpus()?.[0]?.model ?? 'N/A'} × ${os.cpus()?.length ?? '?'}`,
      `mémoire     ${Math.round(os.totalmem() / 1073741824)} Go`,
      `langue      ${dire(reglages?.langue)}`,
    ]),
  )

  morceaux.push(
    section('Installation', [
      `dossier du jeu   ${dire(dossierJeu)}`,
      `UE4SS            ${etatJeu?.ue4ss ? 'présent' : 'absent'}`,
      `point d’accroche ${dire(etatJeu?.accroche)}`,
      `mod VoyageLien   ${etatJeu?.modLien ? 'présent' : 'absent'}`,
      `mod VoyageSonde  ${etatJeu?.modSonde ? 'présent' : 'absent'}`,
      `sauvegardes      ${dire(etatJeu?.sauvegardes)}`,
    ]),
  )

  morceaux.push(
    section('Identité', [
      /*
        ⚠️ L'EMPREINTE N'EST PAS UN SECRET. C'est l'identifiant public du joueur,
           celui qu'un hôte inscrit pour lui donner un rôle. La clé privée, elle,
           n'est jamais lue par ce module.
      */
      `empreinte  ${dire(identite?.empreinte)}`,
      `créée le   ${identite?.creeLe ? new Date(identite.creeLe).toISOString() : 'N/A'}`,
    ]),
  )

  if (lien) {
    morceaux.push(
      section('Lien avec un serveur', [
        `actif    ${lien.actif ? 'oui' : 'non'}`,
        `serveur  ${lien.cible ? `${lien.cible.hote}:${lien.cible.port}` : 'N/A'}`,
        '',
        ...(lien.lignes ?? []).slice(-LIGNES).map((l) => expurger(typeof l === 'string' ? l : `${l.heure ?? ''} ${l.cle ?? ''}`)),
      ]),
    )
  }

  if (hebergement) {
    morceaux.push(
      section('Serveur hébergé ici', [
        `actif      ${hebergement.actif ? 'oui' : 'non'}`,
        `nom        ${dire(hebergement.reglages?.nom)}`,
        `port       ${dire(hebergement.reglages?.port)}`,
        `places     ${dire(hebergement.reglages?.maxJoueurs)}`,
        `protégé    ${hebergement.reglages?.protege ? 'oui' : 'non'}`,
        `public     ${hebergement.reglages?.public ? 'oui' : 'non'}`,
        '',
        ...(hebergement.lignes ?? []).slice(-LIGNES).map((l) => expurger(typeof l === 'string' ? l : `${l.heure ?? ''} ${l.cle ?? ''}`)),
      ]),
    )
  }

  if (serveur) {
    const q = serveur.mesures
    morceaux.push(
      section('Diagnostic du serveur', [
        `joueurs       ${dire(serveur.joueurs)}/${dire(serveur.maxJoueurs)}`,
        `mémoire       ${dire(q?.memoireMo)} Mo`,
        `processeur    ${q?.cpuPourcent === null || q?.cpuPourcent === undefined ? 'N/A' : q.cpuPourcent + ' %'}`,
        `tick moyen    ${dire(q?.ticks?.moyenneMs)} ms (pire ${dire(q?.ticks?.pireMs)})`,
        `réseau        ${dire(q?.reseau?.entrantKoParS)} ↓ / ${dire(q?.reseau?.sortantKoParS)} ↑ ko/s`,
        `instantané    ${dire(q?.instantaneOctets)} o`,
        `annuaire      ${serveur.annuaire ? (serveur.annuaire.actif ? 'actif' : 'éteint') : 'N/A'}`,
        `dernière erreur d’annuaire ${dire(serveur.annuaire?.derniereErreur)}`,
        `perçage       ${serveur.percage ? (serveur.percage.actif ? 'actif' : 'éteint') : 'N/A'}`,
        `billet        ${dire(serveur.percage?.billet)}`,
        `NAT symétrique ${serveur.percage?.symetrique ? 'oui — redirection de port nécessaire' : 'non'}`,
      ]),
    )
  }

  morceaux.push('')
  morceaux.push(`── fin ${'─'.repeat(60)}`)

  const contenu = morceaux.join('\n') + '\n'
  const nom = `voyage-soutien-${maintenant.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`
  const chemin = path.join(dossier, nom)

  fs.mkdirSync(dossier, { recursive: true })
  fs.writeFileSync(chemin, contenu, 'utf8')

  return { chemin, taille: Buffer.byteLength(contenu, 'utf8') }
}

module.exports = { fabriquer, expurger, MOTS_SENSIBLES }
