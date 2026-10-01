'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  TROIS LANGUES, CÔTÉ SERVEUR
 * ═══════════════════════════════════════════════════════════════════════════
 *  Deux publics, deux langues possibles en même temps :
 *
 *    — La CONSOLE et les journaux parlent la langue du serveur (`LANGUE`).
 *      C'est l'hôte qui les lit, et il n'y en a qu'un.
 *    — Les MESSAGES AUX JOUEURS parlent la langue de CHAQUE joueur, annoncée
 *      à l'arrivée par le lanceur. Trois personnes peuvent lire la même partie
 *      en trois langues.
 *
 *  ⚠️ LE FRANÇAIS EST LA RÉFÉRENCE, ET LE SEUL REPLI. Une clé absente d'une
 *     traduction retombe sur le français plutôt que de laisser un trou ou un
 *     identifiant technique à l'écran. Une clé absente PARTOUT rend la clé
 *     elle-même — c'est laid, c'est voulu, et le banc d'essai l'interdit.
 *
 *  ⚠️ ON NE TRADUIT JAMAIS CE QUE LES JOUEURS ÉCRIVENT. Un message de chat, un
 *     pseudo, le nom d'un serveur, la raison d'un bannissement tapée à la main :
 *     ça traverse tel quel. Traduire la parole de quelqu'un serait la réécrire.
 *
 *  ⚠️ LES VALEURS SONT INSÉRÉES, PAS CONCATÉNÉES. `{nom}` dans le texte, et la
 *     valeur à part : une langue qui met le sujet après le verbe garde la
 *     phrase lisible, et personne n'a à recoller des morceaux dans le bon ordre.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const LANGUES = ['fr', 'en', 'es']

/** Le dictionnaire, rempli par `textes.js`. Trois tables, mêmes clés. */
const TEXTES = require('./textes')

/** La langue d'un code quelconque. Tout ce qu'on ne connaît pas vaut français. */
function langueValide(brut) {
  const l = String(brut || '').toLowerCase().slice(0, 2)
  return LANGUES.includes(l) ? l : 'fr'
}

/**
 * Rend un texte dans une langue.
 *
 * ⚠️ UNE VALEUR MANQUANTE LAISSE SON MARQUEUR VISIBLE. `{nom}` affiché à
 *    l'écran est laid, et c'est exactement ce qu'il faut : ça se remarque et ça
 *    se corrige. Le remplacer par du vide donnerait une phrase trouée qui a
 *    l'air normale.
 */
function T(langue, cle, valeurs = null) {
  const l = langueValide(langue)
  const table = TEXTES[l] || TEXTES.fr
  const modele = table[cle] ?? TEXTES.fr[cle] ?? cle
  if (!valeurs) return modele
  return String(modele).replace(/\{(\w+)\}/g, (marqueur, nom) =>
    Object.prototype.hasOwnProperty.call(valeurs, nom) ? String(valeurs[nom]) : marqueur,
  )
}

/*
  ⚠️ LA LANGUE DE LA CONSOLE VIT ICI, PAS DANS `config`. Quinze modules
     l'utilisent ; s'ils requeraient tous `config.js`, le rendez-vous autonome
     — qui tourne seul sur le VPS avec trois fichiers — traînerait toute la
     configuration du serveur derrière lui. Et `config.js` lui-même ne peut
     pas se requérir pour écrire ses propres avertissements.

  ⚠️ ELLE NE CONCERNE QUE L'HÔTE. Les messages aux joueurs passent par la
     langue de CHAQUE joueur, annoncée à son arrivée.
*/
let langueDeLaConsole = langueValide(process.env.LANGUE || process.env.LANG)

/** La langue de la console. `config.js` la pose une fois, au démarrage. */
function consoleEn(l) {
  if (l !== undefined) langueDeLaConsole = langueValide(l)
  return langueDeLaConsole
}

/** Le traducteur de la console : `t('cle', { ... })`, dans la langue de l'hôte. */
function surLaConsole(cle, valeurs) {
  return T(langueDeLaConsole, cle, valeurs)
}

/** Un traducteur figé sur une langue, pour ne pas la répéter à chaque appel. */
function pour(langue) {
  const l = langueValide(langue)
  return (cle, valeurs) => T(l, cle, valeurs)
}

/** Les clés connues, pour les bancs d'essai. */
function cles(langue = 'fr') {
  return Object.keys(TEXTES[langueValide(langue)] || TEXTES.fr)
}

module.exports = { T, pour, langueValide, cles, LANGUES, TEXTES, consoleEn, surLaConsole }
