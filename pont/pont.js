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
 *  ⚠️ LE PONT NE DECIDE DE RIEN. Il relaie ce que le jeu dit et renvoie ce que
 *     le serveur repond. Toute l'autorite reste sur le serveur.
 *
 *  ⚠️ IL SIGNE L'IDENTITE, MAIS IL NE LA FABRIQUE PAS. La cle privee vit dans
 *     le lanceur, qui passe la signature en argument. Le pont ne voit jamais la
 *     cle privee — un pont lance a la main, sans le lanceur, se connecte
 *     simplement en anonyme.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const net = require('node:net')
const dgram = require('node:dgram')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

const TUBE = '\\\\.\\pipe\\voyage-lien'
/** Repli : si le tube echoue, le mod ecrit dans ce fichier et on le suit. */
const FICHIER_REPLI = path.join(os.tmpdir(), 'voyage-lien.txt')

/** Version du protocole parle au serveur. */
const PROTOCOLE = 2

// ── Arguments ───────────────────────────────────────────────────────────────

function argument(nom, defaut) {
  const i = process.argv.indexOf(`--${nom}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : defaut
}

const cible = argument('serveur', '127.0.0.1:7777')
const [hoteInitial, portTexte] = cible.split(':')

/*
  ⚠️ L'ADRESSE DU SERVEUR N'EST PLUS FIGEE. Avec un billet, on ne la connait
     qu'apres avoir interroge le point de rendez-vous : c'est lui qui nous dit
     ou taper. Tant qu'il n'a pas repondu, ces deux valeurs ne veulent rien dire.
*/
let hote = hoteInitial
let port = Number.parseInt(portTexte, 10) || 7777

/*
  Rejoindre par billet, sans que l'hote ait redirige un port.

  ⚠️ LE PERCAGE NE MARCHE PAS PARTOUT, ET ON NE LE PROMET PAS. Un NAT dit
     « symetrique » donne a l'hote un port public different par destination :
     l'adresse apprise au rendez-vous ne vaut alors rien. On essaie, on compte
     les tentatives, et on le DIT au lieu de laisser le joueur attendre.
*/
const billet = (argument('billet', '') || '').toUpperCase().slice(0, 16)
const rendezVousAdresse = argument('rendezvous', '')
let rdv = null
if (billet && rendezVousAdresse) {
  const m = rendezVousAdresse.match(/^([A-Za-z0-9.\-]{1,253}):(\d{1,5})$/)
  if (m) rdv = { adresse: m[1], port: Number.parseInt(m[2], 10) }
}
let hoteTrouve = !billet
let tentativesRdv = 0
const nomJoueur = argument('nom', os.userInfo().username || 'Joueur').slice(0, 24)
const motDePasse = argument('motdepasse', '')

/*
  ⚠️ L'IDENTITE ARRIVE DEJA SIGNEE, OU PAS DU TOUT. Le lanceur tient la cle
     privee et produit la signature ; le pont ne fait que la porter. Sans
     `--cle`, on se connecte en anonyme — ce que le serveur accepte, sauf s'il
     exige une identite.
*/
const clePublique = argument('cle', '')
const identiteTs = Number.parseInt(argument('ts', '0'), 10) || 0
const signature = argument('sig', '')

/** Jeton de reprise garde par le lanceur d'une session a l'autre. */
let jetonReprise = argument('reprise', '')

/*
  Que faire des creatures de l'hote : `miroir`, `annonce` ou `rien`.

  ⚠️ LE MODE EST UN CHOIX LOCAL, PAS UN REGLAGE DU SERVEUR. Masquer ses propres
     creatures pour afficher celles d'un autre ne change rien pour les autres
     joueurs : chacun decide de ce qu'il voit. Le serveur, lui, ne fait que
     fournir la liste.
*/
/*
  Les reglages des plaques de nom, portes jusqu'au mod.

  ⚠️ C'EST UN CHOIX LOCAL, COMME LE MIROIR. Ce que TU affiches au-dessus des
     tetes ne regarde que toi : le serveur n'a pas a en connaitre un mot.
*/
const plaques = {
  noms: argument('plaques', 'oui') !== 'non',
  distance: argument('plaques-distance', 'oui') !== 'non',
  ping: argument('plaques-ping', 'non') === 'oui',
  vie: argument('plaques-vie', 'non') === 'oui',
  portee: Math.min(Math.max(Number.parseInt(argument('plaques-portee', '80'), 10) || 80, 5), 500),
}

/** Mode debug : le mod affiche identifiants, modes de rendu et compteurs. */
const debug = argument('debug', 'non') === 'oui'

const MODES_CREATURES = ['miroir', 'annonce', 'rien']
const modeCreatures = MODES_CREATURES.includes(argument('creatures', 'miroir'))
  ? argument('creatures', 'miroir')
  : 'miroir'

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
    identite: (e) => `identité reconnue : ${e}`,
    anonyme: () => 'connecté en anonyme (aucune identité signée)',
    repris: () => 'ta place a été rendue : position et équipe retrouvées',
    rdvDemande: (b) => `recherche de l'hôte au point de rendez-vous (billet ${b})…`,
    rdvTrouve: (q) => `hôte trouvé : ${q} — on perce le chemin`,
    rdvRefus: (r) => `le point de rendez-vous refuse : ${r}`,
    rdvAbandon: () => 'l’hôte ne répond pas. Son billet a peut-être expiré, ou sa box ne laisse pas percer.',
    rdvSansAdresse: () => 'un billet a été donné, mais aucun point de rendez-vous : impossible de chercher l’hôte.',
    qualite: (r, g, p) => `lien : ${r} ms, gigue ${g} ms, perte ${p} %`,
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
    identite: (e) => `identity recognised: ${e}`,
    anonyme: () => 'connected anonymously (no signed identity)',
    repris: () => 'your seat was returned: position and team restored',
    rdvDemande: (b) => `looking for the host at the rendezvous (ticket ${b})…`,
    rdvTrouve: (q) => `host found: ${q} — punching through`,
    rdvRefus: (r) => `the rendezvous refused: ${r}`,
    rdvAbandon: () => 'the host is not answering. Their ticket may have expired, or their router will not let us through.',
    rdvSansAdresse: () => 'a ticket was given but no rendezvous: cannot look for the host.',
    qualite: (r, g, p) => `link: ${r} ms, jitter ${g} ms, loss ${p} %`,
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
    identite: (e) => `identidad reconocida: ${e}`,
    anonyme: () => 'conectado como anónimo (sin identidad firmada)',
    repris: () => 'te devolvieron tu sitio: posición y equipo recuperados',
    rdvDemande: (b) => `buscando al anfitrión en el punto de encuentro (billete ${b})…`,
    rdvTrouve: (q) => `anfitrión encontrado: ${q} — abriendo el camino`,
    rdvRefus: (r) => `el punto de encuentro rechaza: ${r}`,
    rdvAbandon: () => 'el anfitrión no responde. Su billete puede haber caducado, o su router no deja pasar.',
    rdvSansAdresse: () => 'se dio un billete pero ningún punto de encuentro: no se puede buscar al anfitrión.',
    qualite: (r, g, p) => `enlace: ${r} ms, fluctuación ${g} ms, pérdida ${p} %`,
  },
}

const langue = MOTS[argument('langue', 'fr')] ? argument('langue', 'fr') : 'fr'
const M = (cle, ...a) => MOTS[langue][cle](...a)

function log(...a) {
  console.log(new Date().toISOString().slice(11, 19), ...a)
}

// ── Le chemin retour : deposer ce que le jeu doit savoir ────────────────────

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
const FICHIER_MESSAGE = path.join(os.tmpdir(), 'voyage-message.txt')
const FICHIER_AUTRES = path.join(os.tmpdir(), 'voyage-autres.txt')
const PERIODE_DEPOT = 100

function afficherDansLeJeu(ton, texte) {
  if (!texte) return
  const propre = String(texte).replace(/[\r\n]+/g, ' ').trim()
  if (!propre) return
  try {
    const abri = `${FICHIER_MESSAGE}.tmp`
    fs.writeFileSync(abri, `${ton} ${propre}`, 'utf8')
    fs.renameSync(abri, FICHIER_MESSAGE)
  } catch {
    // Un message perdu ne doit jamais interrompre la partie.
  }
}

let dernierDepot = 0

/** Nettoie un champ qui doit tenir sur une ligne et ne pas contenir d'espace. */
function mot(v, defaut = '-') {
  const propre = String(v ?? '').replace(/[\s\r\n]+/g, '_')
  return propre || defaut
}

/** Nettoie un champ libre : il vient en dernier, il peut contenir des espaces. */
function phrase(v) {
  return String(v ?? '').replace(/[\r\n]+/g, ' ')
}

function nombre(v, decimales = 2) {
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(decimales) : (0).toFixed(decimales)
}

function deposerPourLeJeu(tick, force = false) {
  const maintenant = Date.now()
  if (!force && maintenant - dernierDepot < PERIODE_DEPOT) return
  dernierDepot = maintenant

  /*
    ⚠️ LE MARQUEUR DE FORMAT PASSE A `v3` PARCE QUE LA LIGNE A CHANGE. La vie
       s'insere AVANT le nom — le nom reste en dernier, c'est le seul champ qui
       peut contenir des espaces. Un mod `v2` lirait « vie nom » comme un seul
       nom : le marqueur lui permet de refuser proprement plutot que d'afficher
       des nombres au-dessus des tetes.
  */
  const lignes = [`v3 ${tick || 0} ${autresJoueurs.length}`]

  lignes.push(`hote ${jeSuisHote ? 1 : 0}`)
  lignes.push(`mode ${modeCreatures}`)
  lignes.push(
    `plaques ${plaques.noms ? 1 : 0} ${plaques.distance ? 1 : 0} ${plaques.ping ? 1 : 0} ` +
      `${plaques.vie ? 1 : 0} ${plaques.portee}`,
  )
  lignes.push(`debug ${debug ? 1 : 0}`)

  if (rendezVous && rendezVous.pos) {
    const r = rendezVous
    lignes.push(
      `rdv ${nombre(r.pos.x)} ${nombre(r.pos.y)} ${nombre(r.pos.z)} ` +
        `${nombre(r.rot?.y)} ${phrase(r.parQui || '?')}`,
    )
  }

  /*
    ⚠️ LA CADENCE PART AVEC L'HEURE, ET ELLE DECIDE DE TOUT. A zero, l'horloge du
       serveur est figee : le mod ne doit alors RIEN ecrire dans le ciel du
       joueur, sinon il lui imposerait midi a chaque instantane. C'est le reglage
       `CYCLE_MINUTES` de l'hebergeur qui donne au serveur l'autorite sur le
       temps, pas le simple fait qu'il connaisse une heure.
  */
  if (tempsServeur) {
    lignes.push(
      `t ${tempsServeur.heure ?? 12} ${tempsServeur.minute ?? 0} ` +
        `${tempsServeur.jour ?? 1} ${Number(tempsServeur.cadence) || 0} ` +
        `${phrase(tempsServeur.meteo || 'clair')}`,
    )
  }

  for (const j of autresJoueurs) {
    const p = j.pos || {}
    const r = j.rot || {}
    const v = j.vit || {}
    // Le nom vient en dernier : c'est le seul champ qui peut contenir des espaces.
    lignes.push(
      `j ${j.id} ${nombre(p.x)} ${nombre(p.y)} ${nombre(p.z)} ${nombre(r.y)} ` +
        `${nombre(v.x, 1)} ${nombre(v.y, 1)} ${nombre(v.z, 1)} ` +
        `${j.vie === null || j.vie === undefined ? -1 : Math.round(j.vie)} ` +
        `${phrase(j.nom || j.id)}`,
    )
  }

  /*
    ⚠️ LES CREATURES NE SONT RENVOYEES QU'AUX AUTRES, PAS A L'HOTE. L'hote les
       voit deja dans son jeu : lui renvoyer les siennes l'amenerait a afficher
       des doublons de ses propres requins.
  */
  if (!jeSuisHote) {
    for (const c of creaturesServeur.values()) {
      lignes.push(
        `n ${c.id} ${nombre(c.pos?.x)} ${nombre(c.pos?.y)} ${nombre(c.pos?.z)} ` +
          `${nombre(c.rot?.yaw)} ${c.vie === null || c.vie === undefined ? -1 : Math.round(c.vie)} ` +
          `${mot(c.c)}`,
      )
    }
  }

  for (const c of coffreServeur.slice(0, 12)) {
    lignes.push(`c ${c.nombre} ${phrase(c.nom)}`)
  }

  /*
    ⚠️ LES FAITS SE CONSOMMENT. Un fait est un instant : le laisser dans le
       fichier le ferait reafficher dix fois par seconde.
  */
  for (const f of faitsAMontrer) {
    lignes.push(
      `f ${mot(f.genre)} ${nombre(f.pos?.x)} ${nombre(f.pos?.y)} ${nombre(f.pos?.z)} ${phrase(f.texte)}`,
    )
  }
  faitsAMontrer = []

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

// ── Cote serveur (UDP) ──────────────────────────────────────────────────────

const socket = dgram.createSocket('udp4')
let jeton = null
let monId = null
let jeSuisHote = false
let autresJoueurs = []

/*
  Les creatures de l'hote, par identifiant, avec la derniere fois qu'on les a
  vues.

  ⚠️ ON NE PEUT PAS REMPLACER LA LISTE D'UN COUP. Le serveur n'envoie pas toutes
     les creatures a chaque instantane : les proches arrivent souvent, les
     lointaines rarement. Remplacer la table par ce que porte le dernier paquet
     ferait disparaitre puis reapparaitre les lointaines dix fois par seconde.
     On garde donc chacune, et on l'oublie quand elle cesse d'etre annoncee.
*/
const creaturesServeur = new Map()

/** Au-dela, une creature n'est plus annoncee : elle est morte, ou trop loin. */
const OUBLI_CREATURE_MS = 4000

function retenirLesCreatures(liste) {
  const maintenant = Date.now()
  for (const c of liste) {
    if (!c || c.id === undefined) continue
    creaturesServeur.set(c.id, { ...c, vuLe: maintenant })
  }
  for (const [id, c] of creaturesServeur) {
    if (maintenant - c.vuLe > OUBLI_CREATURE_MS) creaturesServeur.delete(id)
  }
}
let coffreServeur = []
let tempsServeur = null
let faitsAMontrer = []
let rendezVous = null
let derniereReponse = 0
let derniereQualite = null

function envoyer(objet) {
  const corps = jeton && !objet.jeton ? { ...objet, jeton } : objet
  socket.send(Buffer.from(JSON.stringify(corps)), port, hote, () => {})
}

/** Une cle de transaction, pour qu'un renvoi ne fasse pas le travail deux fois. */
function cleTransaction(prefixe) {
  return `${prefixe}-${crypto.randomBytes(8).toString('hex')}`
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
    /*
      Le rendez-vous nous dit ou taper.

      ⚠️ ON TAPE AVANT DE DIRE BONJOUR. Le `bonjour` seul n'ouvrirait rien : la
         box de l'hote ne laisse entrer que ce qui repond a un paquet qu'elle a
         vu sortir. Quelques coups de percage d'abord, le protocole ensuite.
    */
    case 'rdv-hote': {
      if (hoteTrouve) break
      const h = m.hote
      if (!h || typeof h.adresse !== 'string' || !Number.isInteger(h.port)) break
      hote = h.adresse
      port = h.port
      hoteTrouve = true
      log(M('rdvTrouve', m.nom || `${hote}:${port}`))

      const coups = Math.min(Math.max(Number(m.coups) || 3, 1), 10)
      for (let i = 0; i < coups; i++) {
        setTimeout(() => socket.send(Buffer.from(JSON.stringify({ t: 'rdv-salut' })), port, hote, () => {}), i * 120)
      }
      setTimeout(seConnecter, coups * 120 + 100)
      break
    }

    case 'rdv-refus':
      log(M('rdvRefus', m.raison ?? '?'))
      break

    case 'rdv-salut':
      // L'hote a perce vers nous : le chemin est ouvert, il n'y a rien a faire.
      break

    case 'reseau':
      /*
        ⚠️ C'EST NOTRE PROPRE QUALITE, PAS CELLE DES AUTRES. Le serveur mesure
           la gigue et la perte depuis ce qu'il recoit de nous ; lui seul peut
           les connaitre.
      */
      derniereQualite = {
        rtt: m.rtt, gigue: m.gigue, perte: m.perte, etat: m.etat,
      }
      console.log(`##voyage-reseau ${JSON.stringify(derniereQualite)}`)
      log(M('qualite', m.rtt ?? '?', m.gigue ?? '?', m.perte === null || m.perte === undefined ? '?' : m.perte))
      break

    case 'bienvenue':
      jeton = m.jeton
      monId = m.id
      jeSuisHote = m.hote === true
      if (m.reprise) {
        jetonReprise = m.reprise
        // Le lanceur le garde pour la prochaine fois : il survit a un plantage.
        console.log(`##voyage-reprise ${m.reprise}`)
      }
      log(M('connecte', m.serveur, m.nom, m.hote))
      log(m.empreinte ? M('identite', m.empreinte) : M('anonyme'))
      if (m.reprisDeLaPlace) log(M('repris'))
      if (m.temps) tempsServeur = m.temps
      if (m.coffre?.coffre) coffreServeur = m.coffre.coffre
      /*
        ⚠️ ON DEPOSE TOUT DE SUITE, SANS ATTENDRE UN INSTANTANE. Sans ca, le mod
           ne saurait pas qu'il est l'hote avant le premier tick — et un hote qui
           ne le sait pas ne recense aucune creature.
      */
      deposerPourLeJeu(0, true)
      break

    case 'refus':
      log(M('refus', m.raison) + (m.detail ? ` — ${m.detail}` : ''))
      afficherDansLeJeu('erreur', `serveur : ${m.raison}`)
      if (m.raison === 'session_inconnue') {
        jeton = null
        seConnecter()
      }
      break

    case 'instantane':
      autresJoueurs = (m.joueurs || []).filter((j) => j.id !== monId)
      /*
        ⚠️ L'HOTE SE LIT DANS L'INSTANTANE, PAS SEULEMENT A L'ARRIVEE. Il change
           quand quelqu'un part : un pont qui garderait la valeur de l'arrivee
           ferait recenser les creatures par un joueur qui n'est plus hote — et
           le serveur les refuserait sans que personne ne comprenne.
      */
      {
        const moi = (m.joueurs || []).find((j) => j.id === monId)
        if (moi && moi.hote !== jeSuisHote) {
          jeSuisHote = moi.hote === true
          log(jeSuisHote ? 'tu es maintenant l’hôte' : 'tu n’es plus l’hôte')
        }
      }
      if (Array.isArray(m.pnj)) retenirLesCreatures(m.pnj)
      if (m.coffre?.coffre) coffreServeur = m.coffre.coffre
      if (m.temps) tempsServeur = m.temps
      if (m.monde) {
        tempsServeur = {
          heure: m.monde.heure,
          minute: m.monde.minute,
          jour: tempsServeur?.jour ?? 1,
          /*
            ⚠️ LA CADENCE NE VIENT QUE DU MESSAGE `temps`. Un instantane qui
               porte le monde sans le temps ne doit pas la remettre a zero : le
               mod cesserait d'appliquer l'heure sans raison.
          */
          cadence: tempsServeur?.cadence ?? 0,
          meteo: m.monde.meteo,
        }
      }
      deposerPourLeJeu(m.tick)
      break

    case 'hote':
      jeSuisHote = m.id === monId
      log(jeSuisHote ? 'tu es maintenant l’hôte' : `${m.nom} est maintenant l’hôte`)
      deposerPourLeJeu(0, true)
      break

    case 'rdv':
      /*
        ⚠️ ON LE REDEPOSE TOUT DE SUITE. Le fichier n'est reecrit qu'a chaque
           instantane ; sans ce coup de pouce, un point pose pendant qu'on
           est seul n'arriverait au jeu qu'a la prochaine seconde utile.
      */
      rendezVous = m.rdv ?? null
      deposerPourLeJeu(null, true)
      log(rendezVous ? M('rdvPose', rendezVous.parQui) : M('rdvOublie'))
      break

    case 'chat': {
      const marque = m.canal === 'prive' ? '(privé) ' : m.canal === 'equipe' ? `[${m.equipe || 'équipe'}] ` : ''
      log(`${marque}<${m.de}> ${m.texte}`)
      afficherDansLeJeu('info', `${marque}${m.de} : ${m.texte}`)
      break
    }

    case 'systeme':
      log(`[serveur] ${m.texte}`)
      afficherDansLeJeu('bon', m.texte)
      break

    /*
      Un fait ponctuel : porte, alarme, ping, geste. Il s'affiche une fois, dans
      le jeu, puis il est oublie.
    */
    case 'evenement': {
      const texte = texteDUnEvenement(m)
      if (texte) {
        log(texte)
        faitsAMontrer.push({ genre: m.genre, pos: m.pos, texte })
        if (faitsAMontrer.length > 8) faitsAMontrer = faitsAMontrer.slice(-8)
      }
      break
    }

    case 'pnj-fait':
      /*
        ⚠️ UNE MORT OU UNE DISPARITION RETIRE LA CREATURE TOUT DE SUITE. Attendre
           l'expiration laisserait son fantome nager quatre secondes apres que
           l'hote l'a tuee — exactement le genre de decalage qui fait douter de
           tout le reste.
      */
      if ((m.quoi === 'mort' || m.quoi === 'disparition') && m.id !== undefined) {
        creaturesServeur.delete(m.id)
      }
      if (m.quoi === 'remise-a-zero') creaturesServeur.clear()
      if (m.quoi === 'mort') {
        const texte = `une créature est morte (${m.classe || '?'})`
        log(texte)
        faitsAMontrer.push({ genre: 'mort', pos: m.pos, texte })
      }
      break

    case 'coffre':
      if (m.coffre) coffreServeur = m.coffre
      break

    case 'inv-ok':
      if (m.ok) log(`coffre : ${m.nombre} ${m.nom} — il en reste ${m.dansLeCoffre}`)
      else log(`coffre refusé : ${m.refus}`)
      break

    case 'expulse':
      log(`expulsé : ${m.raison}`)
      afficherDansLeJeu('erreur', `tu as été retiré de la partie : ${m.raison}`)
      jeton = null
      break

    case 'depart':
      log(M('depart', m.nom))
      break
  }
})

/**
 * Le texte d'un evenement, ou `null` quand il n'y a rien a dire.
 *
 * ⚠️ TOUS LES EVENEMENTS NE MERITENT PAS UNE LIGNE A L'ECRAN. Un interrupteur
 *    actionne a cinquante metres n'interesse personne ; une alarme, si. Un
 *    evenement sans texte est quand meme relaye : il sert au journal.
 */
function texteDUnEvenement(m) {
  switch (m.genre) {
    case 'alarme':
      return 'une alarme sonne'
    case 'explosion':
      return 'une explosion'
    case 'mort':
      return `${m.de} est tombé`
    case 'ping':
      return `${m.de} marque un point`
    case 'geste':
      return `${m.de} : ${m.valeur}`
    case 'porte':
      return `${m.de} ouvre quelque chose`
    case 'pose':
      return `${m.de} construit`
    default:
      return null
  }
}

function seConnecter() {
  if (!hoteTrouve) return
  log(M('connexion', hote, port, nomJoueur))
  const message = {
    t: 'bonjour',
    nom: nomJoueur,
    protocole: PROTOCOLE,
    version: '0.6.4',
    motDePasse,
    capacites: ['anim', 'nameplate', 'pnj', 'inv', 'evenement', 'temps', 'reseau'],
  }
  if (clePublique && signature && identiteTs) {
    message.cle = clePublique
    message.ts = identiteTs
    message.sig = signature
  }
  if (jetonReprise) message.reprise = jetonReprise
  envoyer(message)
}

/*
  ⚠️ ON SE RECONNECTE TOUT SEUL. Le serveur peut redemarrer pendant que le
     joueur est en jeu ; sans ca il faudrait quitter le jeu pour reprendre.
*/
setInterval(() => {
  /*
    ⚠️ TANT QU'ON N'A PAS L'ADRESSE DE L'HOTE, DIRE BONJOUR NE SERT A RIEN. On
       relance la demande au rendez-vous, et on abandonne au bout d'un moment
       plutot que de laisser le joueur devant un ecran qui ne dit rien.
  */
  if (!hoteTrouve) {
    if (!rdv) {
      log(M('rdvSansAdresse'))
      hoteTrouve = true
      return
    }
    tentativesRdv++
    if (tentativesRdv > 12) {
      log(M('rdvAbandon'))
      hoteTrouve = true
      return
    }
    socket.send(
      Buffer.from(JSON.stringify({ t: 'rdv-joindre', billet })),
      rdv.port,
      rdv.adresse,
      () => {},
    )
    return
  }

  if (!jeton) return seConnecter()
  envoyer({ t: 'ping', ts: Date.now() })
  if (derniereReponse && Date.now() - derniereReponse > 15000) {
    log(M('perdu'))
    jeton = null
  }
}, 3000)

// ── Cote jeu (tube nomme) ───────────────────────────────────────────────────

let seq = 0

/** Lots en cours d'assemblage : le mod envoie ligne par ligne, puis conclut. */
let lotPnj = []
let lotInventaire = []

/**
 * Une ligne venue du jeu.
 *
 * Format volontairement bete, parce qu'il est ecrit par du Lua sans
 * bibliotheque : un mot, puis des champs separes par des espaces.
 *
 * ⚠️ LA LISTE DES MOTS EST FERMEE. Un mot inconnu est jete, jamais relaye tel
 *    quel : sinon le jeu pourrait faire envoyer n'importe quoi au serveur.
 */
function ligneDuJeu(ligne) {
  const bouts = ligne.trim().split(/\s+/)
  const mot0 = bouts[0]

  if (mot0 === 'cmd') {
    /*
      ⚠️ TROIS SORTES DE COMMANDES. Celles qui touchent au disque remontent au
         LANCEUR ; celles qui ne concernent que la partie partent droit au
         SERVEUR. Poser un point de rendez-vous n'a rien a faire sur le disque
         de qui que ce soit.
    */
    if (bouts[1] === 'rdv-poser') return envoyer({ t: 'commande', texte: '/rdv poser' })
    if (bouts[1] === 'geste-salut') return envoyer({ t: 'commande', texte: '/geste salut' })

    const connues = new Set(['installer-monde', 'publier-monde'])
    if (connues.has(bouts[1])) console.log(`##voyage-cmd ${bouts[1]}`)
    return
  }

  if (mot0 === 'pos') {
    const n = bouts.slice(1).map(Number)
    if (n.slice(0, 3).some((v) => !Number.isFinite(v))) return

    seq++
    const etat = {
      t: 'etat',
      pos: { x: n[0], y: n[1], z: n[2] },
      rot: { x: n[3] || 0, y: n[4] || 0, z: n[5] || 0 },
      seq,
      ts: Date.now(),
    }

    /*
      ⚠️ LA VITESSE N'EST JOINTE QUE SI LE MOD L'ENVOIE. C'est elle qui fait
         marcher les jambes des joueurs distants : leur pion porte le blueprint
         d'animation du jeu, et ce blueprint lit la vitesse. Mais un mod plus
         ancien n'envoie que six nombres, et il doit continuer a fonctionner —
         quitte a ce que les autres glissent comme avant.
    */
    if (n.length >= 9 && n.slice(6, 9).every((v) => Number.isFinite(v))) {
      etat.vit = { x: n[6], y: n[7], z: n[8] }
    }

    /*
      ⚠️ LA VIE ARRIVE EN TEXTE, ET « - » VEUT DIRE « INCONNUE ». Le mod ne sait
         pas toujours la lire ; envoyer zero dans ce cas afficherait tout le
         monde comme mourant.
    */
    const vieTexte = bouts[10]
    if (vieTexte && vieTexte !== '-') {
      const v = Number(vieTexte)
      if (Number.isFinite(v)) etat.vie = v
    }
    const posture = bouts[11]
    if (posture && posture !== '-') etat.posture = posture.slice(0, 16)

    return envoyer(etat)
  }

  /*
    Un fait ponctuel vu par le jeu : ev <genre> <x> <y> <z> <cible>
  */
  if (mot0 === 'ev') {
    const genre = bouts[1]
    const x = Number(bouts[2])
    const y = Number(bouts[3])
    const z = Number(bouts[4])
    if (!genre) return
    const message = { t: 'evenement', genre, cible: bouts[5] ? bouts[5].slice(0, 48) : null }
    if ([x, y, z].every(Number.isFinite)) message.pos = { x, y, z }
    return envoyer(message)
  }

  /*
    Creatures : le mod envoie une ligne par creature, puis `pnjfin <n>`.

    ⚠️ ON ACCUMULE AVANT D'ENVOYER. Un paquet par creature ferait soixante
       paquets toutes les deux secondes ; un seul paquet les porte toutes, et le
       serveur les valide d'un coup.
  */
  if (mot0 === 'pnj') {
    const [cle, x, y, z, yaw, vie] = bouts.slice(1, 7)
    const classe = bouts.slice(7).join(' ')
    if (!cle || !classe) return
    if (lotPnj.length >= 64) return
    const pos = { x: Number(x), y: Number(y), z: Number(z) }
    if (!Object.values(pos).every(Number.isFinite)) return
    const entree = { cle, classe, pos }
    if (Number.isFinite(Number(yaw))) entree.rot = { yaw: Number(yaw) }
    const v = Number(vie)
    if (Number.isFinite(v) && v >= 0) entree.vie = v
    lotPnj.push(entree)
    return
  }

  if (mot0 === 'pnjfin') {
    if (lotPnj.length > 0) envoyer({ t: 'pnj', action: 'rapport', liste: lotPnj })
    lotPnj = []
    return
  }

  if (mot0 === 'pnjmort') {
    if (bouts[1]) envoyer({ t: 'pnj', action: 'retrait', cle: bouts[1] })
    return
  }

  /*
    Inventaire : inv <nombre> <nom>, puis `invfin <n>`.
  */
  if (mot0 === 'inv') {
    const nombreObjets = Number(bouts[1])
    const nom = bouts.slice(2).join(' ')
    if (!nom || !Number.isFinite(nombreObjets) || nombreObjets <= 0) return
    if (lotInventaire.length >= 80) return
    lotInventaire.push({ nom: nom.slice(0, 48), nombre: Math.floor(nombreObjets) })
    return
  }

  if (mot0 === 'invfin') {
    if (lotInventaire.length > 0) envoyer({ t: 'inv', action: 'declarer', objets: lotInventaire })
    lotInventaire = []
    return
  }

  /*
    Ce que le mod a reussi a faire dans le jeu : faits k=v;k=v

    ⚠️ C'EST DU DIAGNOSTIC, ET RIEN N'EN DEPEND. Le serveur l'affiche avec
       `/sonde` : c'est ce qui permet de savoir si les animations ou les
       nameplates ont vraiment pris, sans demander au joueur de lire un journal.
  */
  if (mot0 === 'faits') {
    const faits = {}
    for (const paire of ligne.slice(6).split(';')) {
      const [k, v] = paire.split('=')
      if (k && v !== undefined) faits[k.trim().slice(0, 24)] = v.trim().slice(0, 240)
    }
    if (Object.keys(faits).length > 0) envoyer({ t: 'sonde', faits })
    return
  }
}

const serveurTube = net.createServer((flux) => {
  log(M('branche'))
  let reste = ''
  flux.setEncoding('utf8')
  flux.on('data', (bout) => {
    reste += bout
    const lignes = reste.split('\n')
    reste = lignes.pop() ?? ''
    for (const l of lignes) {
      try {
        ligneDuJeu(l)
      } catch {
        // Une ligne illisible ne doit pas couper le lien.
      }
    }
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
  const autres = autresJoueurs.map((j) => `${j.nom} (${Math.round(j.pos?.x ?? 0)}, ${Math.round(j.pos?.z ?? 0)})`)
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

/*
  ⚠️ STDIN SERT DEUX CHOSES, ET L'ORDRE COMPTE. Sa FERMETURE reste le signal
     d'arret — `SIGTERM` ne declenche rien sous Windows, c'est la seule facon
     fiable d'arreter le pont. Mais tant qu'il est ouvert, chaque ligne recue
     est une commande du lanceur. Brancher `data` ne doit donc jamais empecher
     `end` de passer.

  ⚠️ LE CHAT S'ECRIT DANS LE LANCEUR, PAS EN JEU. Le Lua d'UE4SS n'a pas
     d'entree texte, et voler le clavier casserait les commandes du jeu.
*/
let resteStdin = ''

/** Une commande venue du lanceur. La liste est fermee. */
function ligneDuLanceur(ligne) {
  if (ligne.startsWith('chat ')) {
    const texte = ligne.slice(5).trim()
    if (texte) envoyer({ t: 'chat', texte })
    return
  }

  if (ligne.startsWith('chat-local ')) {
    const texte = ligne.slice(11).trim()
    if (texte) envoyer({ t: 'chat', texte, canal: 'local' })
    return
  }

  if (ligne.startsWith('chat-equipe ')) {
    const texte = ligne.slice(12).trim()
    if (texte) envoyer({ t: 'chat', texte, canal: 'equipe' })
    return
  }

  if (ligne.startsWith('commande ')) {
    const texte = ligne.slice(9).trim()
    if (texte) envoyer({ t: 'commande', texte: texte.startsWith('/') ? texte : `/${texte}` })
    return
  }

  /*
    Coffre commun : « deposer 10 ferraille ».

    ⚠️ CHAQUE MOUVEMENT PORTE UNE CLE NEUVE. L'UDP duplique ; sans elle, un
       paquet renvoye deposerait deux fois.
  */
  if (ligne.startsWith('deposer ') || ligne.startsWith('retirer ')) {
    const action = ligne.startsWith('deposer ') ? 'deposer' : 'retirer'
    const reste = ligne.slice(8).trim()
    const [nombreTexte, ...nomBouts] = reste.split(/\s+/)
    const nombreObjets = Number.parseInt(nombreTexte, 10)
    const nom = nomBouts.join(' ')
    if (!nom || !Number.isFinite(nombreObjets) || nombreObjets <= 0) return
    envoyer({ t: 'inv', action, cle: cleTransaction(action), nom, nombre: nombreObjets })
    return
  }

  if (ligne === 'coffre') {
    envoyer({ t: 'inv', action: 'voir' })
    return
  }
}

process.stdin.on('data', (bout) => {
  resteStdin += bout.toString('utf8')
  let coupure = resteStdin.indexOf('\n')
  while (coupure >= 0) {
    const ligne = resteStdin.slice(0, coupure).replace(/\r$/, '').trim()
    resteStdin = resteStdin.slice(coupure + 1)
    try {
      ligneDuLanceur(ligne)
    } catch {
      // Une commande illisible ne doit pas couper le pont.
    }
    coupure = resteStdin.indexOf('\n')
  }
  // Une ligne sans fin ne doit pas gonfler indefiniment.
  if (resteStdin.length > 4096) resteStdin = ''
})
process.stdin.on('end', partir)
process.stdin.on('close', partir)
process.stdin.on('error', () => {})
process.stdin.resume()

/*
  ⚠️ AVEC UN BILLET, ON NE SE CONNECTE PAS TOUT DE SUITE. On demande d'abord
     l'adresse au rendez-vous ; le battement s'en charge et relance si besoin.
*/
if (hoteTrouve) {
  seConnecter()
} else {
  log(M('rdvDemande', billet))
  socket.send(Buffer.from(JSON.stringify({ t: 'rdv-joindre', billet })), rdv.port, rdv.adresse, () => {})
}
