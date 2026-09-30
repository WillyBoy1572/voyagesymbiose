'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PONT — entre le jeu et le serveur
 * ═══════════════════════════════════════════════════════════════════════════
 *      node pont/pont.js --serveur 192.168.0.50:30150 --nom Emeric
 *
 *  ⚠️ IL EXISTE PARCE QUE LE LUA D'UE4SS N'A PAS DE SOCKETS. Le mod dans le
 *     jeu ne sait ni ouvrir une connexion UDP ni en lire une. Il sait en
 *     revanche ouvrir un FICHIER — et sous Windows, un tube nomme s'ouvre
 *     comme un fichier. Le mod ecrit donc ses lignes dans le tube, et ce
 *     programme-ci fait le reseau.
 *
 *  ⚠️ LE PONT NE DECIDE DE RIEN. Il relaie la position telle que le jeu la
 *     donne et renvoie ce que le serveur repond. Toute l'autorite reste sur
 *     le serveur.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const net = require('node:net')
const dgram = require('node:dgram')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

const TUBE = '\\\\.\\pipe\\voyage-lien'
/** Repli : si le tube echoue, le mod ecrit dans ce fichier et on le suit. */
const FICHIER_REPLI = path.join(os.tmpdir(), 'voyage-lien.txt')

// ── Arguments ───────────────────────────────────────────────────────────────

function argument(nom, defaut) {
  const i = process.argv.indexOf(`--${nom}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut
}

const cible = argument('serveur', '127.0.0.1:7777')
const [hote, portTexte] = cible.split(':')
const port = Number.parseInt(portTexte, 10) || 7777
const nomJoueur = argument('nom', os.userInfo().username || 'Joueur').slice(0, 24)
const motDePasse = argument('motdepasse', '')


// ── Les mots du pont ────────────────────────────────────────────────────────

/*
  ⚠️ LE PONT ECRIT DANS LA FENETRE DU LANCEUR. Ses phrases doivent donc
     suivre la langue choisie la-bas, sinon le journal ressort en francais
     au milieu d'une interface en anglais. Le lanceur passe `--langue`.

  ⚠️ CE QUI VIENT DU SERVEUR N'EST PAS TRADUIT : un message de chat ou une
     annonce d'hote appartiennent au serveur, pas a nous.
*/
const MOTS = {
  fr: {
    connexion: (h, p, n) => `connexion à ${h}:${p} en tant que « ${n} »…`,
    connecte: (s, n, h) => `connecté à « ${s} » — tu es ${n}${h ? ' (hôte)' : ''}`,
    refus: (r) => `refusé par le serveur : ${r}`,
    perdu: () => 'plus de nouvelles du serveur, on recommence',
    depart: (n) => `${n} a quitté la partie`,
    tubePret: (t) => `tube prêt : ${t}`,
    tubeSouci: (m) => `tube : ${m}`,
    branche: () => 'le jeu est branché',
    debranche: () => 'le jeu s’est débranché',
    rdvPose: (qui) => `point de rendez-vous posé par ${qui}`,
    rdvOublie: () => 'point de rendez-vous oublié',
    envoye: (n, autres) => `envoyé ${n} positions · ${autres.length ? 'avec toi : ' + autres.join(', ') : 'seul pour l’instant'}`,
  },
  en: {
    connexion: (h, p, n) => `connecting to ${h}:${p} as “${n}”…`,
    connecte: (s, n, h) => `connected to “${s}” — you are ${n}${h ? ' (host)' : ''}`,
    refus: (r) => `server refused us: ${r}`,
    perdu: () => 'no news from the server, starting over',
    depart: (n) => `${n} left the game`,
    tubePret: (t) => `pipe ready: ${t}`,
    tubeSouci: (m) => `pipe: ${m}`,
    branche: () => 'the game is plugged in',
    debranche: () => 'the game unplugged',
    rdvPose: (qui) => `rally point set by ${qui}`,
    rdvOublie: () => 'rally point cleared',
    envoye: (n, autres) => `sent ${n} positions · ${autres.length ? 'with you: ' + autres.join(', ') : 'alone for now'}`,
  },
  es: {
    connexion: (h, p, n) => `conectando a ${h}:${p} como «${n}»…`,
    connecte: (s, n, h) => `conectado a «${s}» — eres ${n}${h ? ' (anfitrión)' : ''}`,
    refus: (r) => `el servidor nos rechazó: ${r}`,
    perdu: () => 'sin noticias del servidor, empezamos de nuevo',
    depart: (n) => `${n} dejó la partida`,
    tubePret: (t) => `tubería lista: ${t}`,
    tubeSouci: (m) => `tubería: ${m}`,
    branche: () => 'el juego está conectado',
    debranche: () => 'el juego se desconectó',
    rdvPose: (qui) => `punto de encuentro puesto por ${qui}`,
    rdvOublie: () => 'punto de encuentro borrado',
    envoye: (n, autres) => `enviadas ${n} posiciones · ${autres.length ? 'contigo: ' + autres.join(', ') : 'solo por ahora'}`,
  },
}

const langue = MOTS[argument('langue', 'fr')] ? argument('langue', 'fr') : 'fr'
const M = (cle, ...a) => MOTS[langue][cle](...a)


// ── Le chemin retour : deposer les autres joueurs ───────────────────────────

/*
  ⚠️ UN FICHIER, PAS UN TUBE. Le mod Lua tourne dans le fil de jeu ; une
     lecture de tube y BLOQUE tant que rien n'arrive, et le jeu se fige. Un
     petit fichier relu sans attendre ne fige jamais rien.

  ⚠️ ON ECRIT A COTE PUIS ON RENOMME. Sans ca le mod peut lire un fichier a
     moitie ecrit et faire clignoter les fantomes ; `rename` remplace d'un
     seul geste.

  ⚠️ LA PREMIERE LIGNE ANNONCE LE NOMBRE DE JOUEURS. C'est la ceinture du
     mod : si le compte ne tombe pas juste, il jette la lecture.
*/
const FICHIER_AUTRES = path.join(os.tmpdir(), 'voyage-autres.txt')
const PERIODE_DEPOT = 100

let dernierDepot = 0

function deposerLesAutres(tick) {
  const maintenant = Date.now()
  if (maintenant - dernierDepot < PERIODE_DEPOT) return
  dernierDepot = maintenant

  const lignes = [`v1 ${tick || 0} ${autresJoueurs.length}`]
  if (rendezVous && rendezVous.pos) {
    const r = rendezVous
    lignes.push(
      `rdv ${Number(r.pos.x || 0).toFixed(2)} ${Number(r.pos.y || 0).toFixed(2)} ` +
        `${Number(r.pos.z || 0).toFixed(2)} ${Number(r.rot?.y || 0).toFixed(2)} ` +
        `${String(r.parQui || '?').replace(/[\r\n]/g, ' ')}`,
    )
  }
  for (const j of autresJoueurs) {
    const p = j.pos || {}
    const r = j.rot || {}
    // Le nom vient en dernier : c'est le seul champ qui peut contenir des espaces.
    const nom = String(j.nom || j.id).replace(/[\r\n]/g, ' ')
    lignes.push(
      `j ${j.id} ${Number(p.x || 0).toFixed(2)} ${Number(p.y || 0).toFixed(2)} ` +
        `${Number(p.z || 0).toFixed(2)} ${Number(r.y || 0).toFixed(2)} ${nom}`,
    )
  }

  try {
    const abri = `${FICHIER_AUTRES}.tmp`
    fs.writeFileSync(abri, lignes.join('\n') + '\n', 'utf8')
    fs.renameSync(abri, FICHIER_AUTRES)
  } catch {
    /* le disque peut etre occupe : on reessaiera dans 100 ms */
  }
}

/** Plus personne a montrer : on ne laisse pas de fantomes derriere nous. */
function effacerLesAutres() {
  try {
    fs.rmSync(FICHIER_AUTRES, { force: true })
    fs.rmSync(`${FICHIER_AUTRES}.tmp`, { force: true })
  } catch {
    /* rien a faire */
  }
}

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a)
}

// ── Cote serveur (UDP) ──────────────────────────────────────────────────────

const socket = dgram.createSocket('udp4')
let jeton = null
let monId = null
let autresJoueurs = []
let rendezVous = null
let derniereReponse = 0

function envoyer(objet) {
  const corps = jeton && !objet.jeton ? { ...objet, jeton } : objet
  socket.send(Buffer.from(JSON.stringify(corps)), port, hote, () => {})
}

socket.on('message', (tampon) => {
  let m
  try {
    m = JSON.parse(tampon.toString('utf8'))
  } catch {
    return
  }
  derniereReponse = Date.now()

  switch (m.t) {
    case 'bienvenue':
      jeton = m.jeton
      monId = m.id
      log(M('connecte', m.serveur, m.nom, m.hote))
      break

    case 'refus':
      log(M('refus', m.raison))
      if (m.raison === 'session_inconnue') {
        jeton = null
        seConnecter()
      }
      break

    case 'instantane':
      autresJoueurs = (m.joueurs || []).filter((j) => j.id !== monId)
      deposerLesAutres(m.tick)
      break

    case 'rdv':
      /*
        ⚠️ ON LE REDEPOSE TOUT DE SUITE. Le fichier n'est reecrit qu'a chaque
           instantane ; sans ce coup de pouce, un point pose pendant qu'on
           est seul n'arriverait au jeu qu'a la prochaine seconde utile.
      */
      rendezVous = m.rdv ?? null
      deposerLesAutres(null)
      log(rendezVous ? M('rdvPose', rendezVous.parQui) : M('rdvOublie'))
      break

    case 'chat':
      log(`<${m.de}> ${m.texte}`)
      break

    case 'systeme':
      log(`[serveur] ${m.texte}`)
      break

    case 'depart':
      log(M('depart', m.nom))
      break
  }
})

function seConnecter() {
  log(M('connexion', hote, port, nomJoueur))
  envoyer({ t: 'bonjour', nom: nomJoueur, protocole: 1, version: '0.1.0', motDePasse })
}

/*
  ⚠️ ON SE RECONNECTE TOUT SEUL. Le serveur peut redemarrer pendant que le
     joueur est en jeu ; sans ca il faudrait quitter le jeu pour reprendre.
*/
setInterval(() => {
  if (!jeton) return seConnecter()
  envoyer({ t: 'ping', ts: Date.now() })
  if (derniereReponse && Date.now() - derniereReponse > 15000) {
    log(M('perdu'))
    jeton = null
  }
}, 3000)

// ── Cote jeu (tube nomme) ───────────────────────────────────────────────────

let seq = 0

/**
 * Une ligne venue du jeu.
 *
 * Format volontairement bete, parce qu'il est ecrit par du Lua sans
 * bibliotheque : `pos <x> <y> <z> <pitch> <yaw> <roll>`
 */
function ligneDuJeu(ligne) {
  const bouts = ligne.trim().split(/\s+/)

  /*
    ⚠️ LE PONT NE TRAITE PAS LES COMMANDES, IL LES PASSE. Installer un monde
       veut dire ecraser des sauvegardes : c'est au lanceur de le faire, avec
       sa copie de securite et ses verifications. Le pont ne fait que porter.

    ⚠️ LA LISTE EST FERMEE. Un mot venu du jeu ne devient jamais une commande
       inconnue relayee telle quelle : on n'accepte que ce qu'on a prevu.
  */
  if (bouts[0] === 'cmd') {
    /*
      ⚠️ DEUX SORTES DE COMMANDES. Celles qui touchent au disque remontent au
         LANCEUR ; celles qui ne concernent que la partie partent droit au
         SERVEUR. Poser un point de rendez-vous n'a rien a faire sur le
         disque de qui que ce soit.
    */
    if (bouts[1] === 'rdv-poser') {
      envoyer({ t: 'commande', texte: '/rdv poser' })
      return
    }

    const connues = new Set(['installer-monde', 'publier-monde'])
    if (connues.has(bouts[1])) console.log(`##voyage-cmd ${bouts[1]}`)
    return
  }

  if (bouts[0] !== 'pos' || bouts.length < 4) return

  const n = bouts.slice(1).map(Number)
  if (n.slice(0, 3).some((v) => !Number.isFinite(v))) return

  seq++
  envoyer({
    t: 'etat',
    pos: { x: n[0], y: n[1], z: n[2] },
    rot: { x: n[3] || 0, y: n[4] || 0, z: n[5] || 0 },
    seq,
  })
}

const serveurTube = net.createServer((flux) => {
  log(M('branche'))
  let reste = ''
  flux.setEncoding('utf8')
  flux.on('data', (bout) => {
    reste += bout
    const lignes = reste.split('\n')
    reste = lignes.pop() ?? ''
    for (const l of lignes) ligneDuJeu(l)
  })
  flux.on('error', () => {})
  flux.on('close', () => log(M('debranche')))
})

serveurTube.on('error', (e) => log(M('tubeSouci', e.message)))
serveurTube.listen(TUBE, () => log(M('tubePret', TUBE)))

/*
  ⚠️ REPLI PAR FICHIER. Si le tube ne marche pas (droits, version de Windows),
     le mod bascule sur un fichier ; on le relit alors regulierement. Moins
     elegant, mais mieux qu'un joueur bloque.
*/
let taillePrecedente = 0
setInterval(() => {
  try {
    if (!fs.existsSync(FICHIER_REPLI)) return
    const taille = fs.statSync(FICHIER_REPLI).size
    if (taille === taillePrecedente) return
    if (taille < taillePrecedente) taillePrecedente = 0 // le fichier a ete remis a zero
    const bout = fs.readFileSync(FICHIER_REPLI, 'utf8').slice(taillePrecedente)
    taillePrecedente = taille
    for (const l of bout.split('\n')) if (l.trim()) ligneDuJeu(l)
  } catch {
    /* le fichier peut etre en cours d'ecriture */
  }
}, 100)

// ── Etat lisible ────────────────────────────────────────────────────────────

setInterval(() => {
  if (!jeton) return
  const autres = autresJoueurs.map((j) => `${j.nom} (${j.pos.x.toFixed(0)}, ${j.pos.z.toFixed(0)})`)
  log(M('envoye', seq, autres))
}, 5000)

/**
 * Partir proprement.
 *
 * ⚠️ SOUS WINDOWS, SIGTERM NE SE GERE PAS. `child.kill('SIGTERM')` y met fin
 *    au processus d'autorite : le gestionnaire ci-dessous n'est jamais
 *    appele, l'`adieu` ne part pas, et le joueur reste affiche sur le
 *    serveur jusqu'a expiration du delai d'inactivite. On ecoute donc aussi
 *    l'ENTREE STANDARD : le lanceur la referme, et ca, ca marche partout.
 */
let enTrainDePartir = false
function partir() {
  if (enTrainDePartir) return
  enTrainDePartir = true
  envoyer({ t: 'adieu' })
  effacerLesAutres()
  setTimeout(() => process.exit(0), 200)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(signal, partir)
  } catch {
    /* tous les signaux n'existent pas partout */
  }
}

process.stdin.on('end', partir)
process.stdin.on('close', partir)
process.stdin.on('error', () => {})
process.stdin.resume()

seConnecter()
