'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LIENS D'INVITATION — `voyage://`
 * ═══════════════════════════════════════════════════════════════════════════
 *  « Rejoins-moi » devrait être un lien qu'on colle dans Discord, pas une
 *  dictée de douze chiffres.
 *
 *  Deux formes, et deux seulement :
 *    `voyage://join/144.217.162.237:30158`   une adresse
 *    `voyage://billet/ABCD2345`              un billet de perçage
 *
 *  ⚠️ UN LIEN NE PORTE JAMAIS DE MOT DE PASSE. Une URL finit dans l'historique
 *     du navigateur, dans les journaux d'un salon, dans un presse-papiers
 *     partagé, et parfois dans un moteur de recherche. Le lien dit qu'un mot de
 *     passe est demandé ; c'est le lanceur qui le demande, à l'instant où il en
 *     a besoin.
 *
 *  ⚠️ CE QUI ARRIVE PAR UN LIEN EST HOSTILE JUSQU'À PREUVE DU CONTRAIRE. Un lien
 *     se clique sans réfléchir : tout est borné, filtré caractère par caractère,
 *     et rien n'est exécuté. Au pire, le lanceur propose de rejoindre une
 *     adresse qui ne répondra pas.
 *
 *  ⚠️ ON NE REJOINT JAMAIS TOUT SEUL. Le lien PROPOSE ; le joueur accepte. Un
 *     lanceur qui se connecte au clic d'un lien est un lanceur qu'on peut
 *     téléguider.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Un billet n'a que des lettres et des chiffres, et jamais plus de seize. */
const BILLET_MAX = 16

/** Un nom d'hôte raisonnable. Au-delà, ce n'est pas une adresse. */
const HOTE_MAX = 253

/**
 * Lit un lien d'invitation. Rend `{hote, port, protege}`, `{billet, protege}`,
 * ou `null` si ce n'en est pas un.
 */
function lire(brut) {
  const texte = String(brut || '').trim()
  /*
    ⚠️ LA PARTIE UTILE DOIT FINIR LE LIEN, pas se contenter de le commencer.
       Sans l'ancrage, « voyage://join/pas valide » rendait l'hôte « pas » : on
       retenait le premier mot d'une adresse manifestement cassée, et le joueur
       se serait connecté à autre chose que ce qu'il croyait.
  */
  const m = texte.match(/^voyage:\/\/(join|billet)\/([^/?#\s]{1,120})(?:[?#]|$)/i)
  if (!m) return null

  const protege = /[?&]protege=1(?:[&#]|$)/i.test(texte)

  if (m[1].toLowerCase() === 'billet') {
    /*
      ⚠️ ON NE GARDE QUE LES LETTRES ET LES CHIFFRES. Un billet est fabriqué dans
         un alphabet sans ambiguïté ; tout le reste est une tentative de faire
         passer autre chose.
    */
    const billet = m[2].toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, BILLET_MAX)
    return billet ? { billet, protege } : null
  }

  let adresse
  try {
    adresse = decodeURIComponent(m[2])
  } catch {
    // Un encodage cassé n'est pas une adresse.
    return null
  }

  const a = adresse.match(/^([A-Za-z0-9.\-]{1,253})(?::(\d{1,5}))?$/)
  if (!a || a[1].length > HOTE_MAX) return null

  /*
    ⚠️ CHAQUE ÉTIQUETTE D'UN NOM D'HÔTE TIENT EN 63 CARACTÈRES. C'est la règle
       du DNS, et c'est ce qui distingue « voyage.example.ca » d'une suite de
       deux cents lettres qui ne désignera jamais rien. Sans ce test, un lien
       pouvait faire afficher au lanceur une « adresse » absurde comme si elle
       était valable.
  */
  if (a[1].split('.').some((etiquette) => etiquette.length === 0 || etiquette.length > 63)) {
    return null
  }

  const port = a[2] ? Number.parseInt(a[2], 10) : 7777
  if (port < 1 || port > 65535) return null

  return { hote: a[1], port, protege }
}

/**
 * Fabrique un lien à partager.
 *
 * ⚠️ `protege` DIT QU'IL FAUDRA UN MOT DE PASSE, IL NE LE DONNE PAS. C'est tout
 *    ce qu'un lien a le droit de savoir là-dessus : l'invité sait qu'on lui
 *    demandera quelque chose, et le lien reste publiable.
 */
function fabriquer({ hote, port, billet, protege = false }) {
  const marque = protege ? '?protege=1' : ''

  if (billet) {
    const propre = String(billet).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, BILLET_MAX)
    return propre ? `voyage://billet/${propre}${marque}` : null
  }

  if (!hote) return null
  const h = String(hote).trim()
  if (!/^[A-Za-z0-9.\-]{1,253}$/.test(h)) return null
  // Même règle à la fabrication qu'à la lecture : sinon on produit des liens
  // que notre propre lecteur refuserait.
  if (h.split('.').some((etiquette) => etiquette.length === 0 || etiquette.length > 63)) return null
  const p = Number.parseInt(port, 10)
  if (!Number.isFinite(p) || p < 1 || p > 65535) return null

  return `voyage://join/${h}:${p}${marque}`
}

/** Cherche un lien d'invitation dans une ligne de commande. */
function dansLesArguments(arguments_) {
  for (const a of arguments_ || []) {
    const i = lire(a)
    if (i) return i
  }
  return null
}

module.exports = { lire, fabriquer, dansLesArguments, BILLET_MAX }
