'use strict'

const fs = require('node:fs')
const path = require('node:path')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ADMINISTRER UN SERVEUR À DISTANCE
 * ═══════════════════════════════════════════════════════════════════════════
 *  Celui qui tient un serveur loué n'a, aujourd'hui, que le gestionnaire de
 *  fichiers de son panneau pour agir dessus. Avec sa clé d'administration, le
 *  lanceur lui donne la même chose que pour un serveur hébergé chez lui : qui
 *  est connecté, expulser, bannir, et n'importe quelle commande.
 *
 *  ⚠️ LES CLÉS NE SORTENT JAMAIS DU PROCESSUS PRINCIPAL. La page demande « les
 *     joueurs du serveur X » ; c'est ici qu'on ajoute la clé à la requête. Une
 *     page web qui détiendrait des clés d'administration serait une page web
 *     qui peut les perdre.
 *
 *  ⚠️ ELLES SONT ÉCRITES EN CLAIR SUR LE DISQUE DU JOUEUR, et il faut le savoir.
 *     Le lanceur n'a pas de coffre : il n'y a pas de secret de machine sur
 *     lequel s'appuyer sous Windows sans dépendance native. Le fichier est dans
 *     le dossier de l'application, propre à l'utilisateur, en 0600 là où le
 *     système le respecte. C'est honnête, et c'est dit dans l'interface.
 *
 *  ⚠️ UNE CLÉ N'EST PAS UN MOT DE PASSE DE SERVEUR. L'une ouvre l'administration,
 *     l'autre laisse entrer en jeu : les confondre ferait donner la première à
 *     des joueurs.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Au-delà, le serveur est considéré muet. */
const DELAI_MS = 3000

let fichier = null
let cles = {}

function cle(hote, port) {
  return `${hote}:${port}`
}

/**
 * Pose le fichier où vivent les clés, et les charge.
 *
 * ⚠️ LE MODULE NE DEVINE PAS OÙ. `app.getPath` n'existe que dans le processus
 *    principal d'Electron ; un module qui l'appellerait ne serait plus testable
 *    hors d'Electron.
 */
function poserContexte({ dossier }) {
  fichier = dossier ? path.join(dossier, 'cles-admin.json') : null
  cles = {}
  if (!fichier) return
  try {
    const d = JSON.parse(fs.readFileSync(fichier, 'utf8'))
    if (d && typeof d === 'object') cles = d
  } catch {
    /* premier démarrage */
  }
}

function enregistrer() {
  if (!fichier) return false
  try {
    fs.mkdirSync(path.dirname(fichier), { recursive: true })
    const abri = `${fichier}.tmp`
    fs.writeFileSync(abri, JSON.stringify(cles, null, 1), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(abri, fichier)
    return true
  } catch {
    return false
  }
}

/** Retient une clé pour un serveur. Une clé vide la retire. */
function poserCle(hote, port, valeur) {
  const k = cle(hote, port)
  const propre = String(valeur || '').trim().slice(0, 128)
  if (!propre) delete cles[k]
  else cles[k] = propre
  enregistrer()
  return { configure: Boolean(propre) }
}

/** Quels serveurs ont une clé. ⚠️ Les clés elles-mêmes ne sortent pas. */
function serveursConfigures() {
  return Object.keys(cles).map((k) => {
    const i = k.lastIndexOf(':')
    return { hote: k.slice(0, i), port: Number.parseInt(k.slice(i + 1), 10) }
  })
}

function aUneCle(hote, port) {
  return Boolean(cles[cle(hote, port)])
}

/**
 * Appelle une route d'administration.
 *
 * ⚠️ UN 404 NE VEUT PAS DIRE « ROUTE ABSENTE ». Le serveur répond 404 — et pas
 *    401 — quand la clé est mauvaise ou absente, exprès : un 401 confirmerait à
 *    un curieux qu'il y a une porte. Côté lanceur, on le traduit par « clé
 *    refusée », parce que c'est bien ce que ça veut dire quand c'est nous qui
 *    demandons.
 */
async function appeler(hote, port, chemin, options = {}) {
  const k = cles[cle(hote, port)]
  if (!k) return { ok: false, cle: 'err.adminSansCle' }

  try {
    const r = await fetch(`http://${hote}:${Number(port) + 1}${chemin}`, {
      ...options,
      headers: { 'X-Admin-Cle': k, 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: AbortSignal.timeout(DELAI_MS),
    })
    if (r.status === 404) return { ok: false, cle: 'err.adminRefuse' }
    if (!r.ok) return { ok: false, cle: 'err.adminHttp', valeurs: { code: r.status } }
    return { ok: true, corps: await r.json().catch(() => null) }
  } catch (e) {
    return { ok: false, cle: 'err.adminInjoignable', valeurs: { raison: e.name === 'TimeoutError' ? 'délai dépassé' : 'injoignable' } }
  }
}

async function etat(hote, port) {
  return appeler(hote, port, '/admin/etat')
}

async function joueurs(hote, port) {
  return appeler(hote, port, '/admin/joueurs')
}

async function sanctions(hote, port) {
  return appeler(hote, port, '/admin/sanctions')
}

/**
 * Lance une commande sur le serveur.
 *
 * ⚠️ LE LANCEUR N'INTERPRÈTE RIEN. C'est le serveur qui décide si la commande
 *    existe et ce qu'elle fait ; filtrer ici obligerait à tenir la liste en deux
 *    endroits, et l'un des deux finirait périmé.
 */
async function commande(hote, port, texte) {
  const propre = String(texte || '').slice(0, 240).trim()
  if (!propre) return { ok: false, cle: 'err.commandeVide' }
  return appeler(hote, port, '/admin/commande', {
    method: 'POST',
    body: JSON.stringify({ texte: propre }),
  })
}

async function annoncer(hote, port, texte) {
  const propre = String(texte || '').slice(0, 240).trim()
  if (!propre) return { ok: false, cle: 'err.commandeVide' }
  return appeler(hote, port, '/admin/annoncer', {
    method: 'POST',
    body: JSON.stringify({ texte: propre }),
  })
}

module.exports = {
  poserContexte,
  poserCle,
  aUneCle,
  serveursConfigures,
  etat,
  joueurs,
  sanctions,
  commande,
  annoncer,
}
