'use strict'

const http = require('node:http')
const fs = require('node:fs')
const journal = require('./journal')
const { TAILLE_MAX } = require('./sauvegardes')
const transport = require('./transport')

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LE COTE TCP : etat du serveur, monde, sante, sauvegardes, administration
 * ═══════════════════════════════════════════════════════════════════════════
 *  C'est par la que passent le navigateur de serveurs, la synchronisation de
 *  monde et les outils d'hebergement. Le jeu, lui, reste en UDP.
 *
 *  ⚠️ AUCUN SECRET NE SORT DES ROUTES PUBLIQUES. Pas de mot de passe, pas de
 *     jeton de session, pas d'adresse IP de joueur : juste de quoi afficher
 *     une carte de serveur. Ce port peut etre expose publiquement.
 *
 *  ⚠️ LES ROUTES D'ADMINISTRATION SONT DERRIERE UNE CLE, ET ELLES N'EXISTENT
 *     PAS SANS ELLE. Sans `ADMIN_CLE`, `/admin/...` repond 404 — pas 401. Un
 *     401 dirait a un curieux qu'il y a quelque chose a trouver.
 *
 *  ⚠️ PAS DE CACHE. Un etat de serveur en cache est un mensonge : il montre
 *     trois joueurs quand il n'y en a plus.
 *
 *  ⚠️ PUBLIER UN MONDE DEMANDE UN MOT DE PASSE. C'est la seule route publique
 *     qui ecrit. Tout le reste est en lecture seule.
 */

function json(reponse, code, corps) {
  const texte = JSON.stringify(corps)
  reponse.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  })
  reponse.end(texte)
}

/**
 * Lit le corps d'une requete, en refusant tout de suite ce qui est trop gros.
 *
 * ⚠️ ON COUPE PENDANT LA RECEPTION, PAS APRES. Attendre la fin pour mesurer
 *    laisserait n'importe qui remplir la memoire du serveur.
 */
function lireCorps(requete, maximum) {
  return new Promise((resolve, rejeter) => {
    const morceaux = []
    let total = 0
    requete.on('data', (m) => {
      total += m.length
      if (total > maximum) {
        rejeter(new Error('corps trop gros'))
        requete.destroy()
        return
      }
      morceaux.push(m)
    })
    requete.on('end', () => resolve(Buffer.concat(morceaux)))
    requete.on('error', rejeter)
  })
}

/**
 * Compare deux secrets sans que la duree de la comparaison ne trahisse le bon.
 *
 * ⚠️ `a === b` SUR UN SECRET EST UNE FUITE. La comparaison s'arrete au premier
 *    caractere different : le temps de reponse revele combien de caracteres
 *    sont justes, et on remonte la cle lettre par lettre.
 */
function memeSecret(a, b) {
  const x = Buffer.from(String(a ?? ''))
  const y = Buffer.from(String(b ?? ''))
  if (x.length !== y.length) return false
  try {
    return require('node:crypto').timingSafeEqual(x, y)
  } catch {
    return false
  }
}

function creerHttp(config, session, monde, sauvegardes, modules = {}) {
  const { mesures, entites, pnj, equipes, activites, inventaires, identites, moderation, ressources, annuaire, temps } =
    modules

  /**
   * La cle d'administration. Vide = les routes `/admin/...` n'existent pas.
   *
   * ⚠️ ELLE VIENT DE `config`, PAS DE `process.env`. Lue ici en direct, elle
   *    sautait le repli par fichier de `config.js` : posee dans
   *    `donnees/reglages.env` — le seul endroit ou un locataire de panneau peut
   *    l'ecrire — elle n'etait jamais vue, et `/admin/etat` repondait 404 comme
   *    si aucune cle n'avait ete configuree.
   */
  const cleAdmin = String(config.cleAdmin ?? '').trim()

  const serveur = http.createServer(async (requete, reponse) => {
    const url = new URL(requete.url || '/', 'http://local')
    const chemin = url.pathname.replace(/\/+$/, '') || '/'

    // ── Ecriture : publier un monde ─────────────────────────────────────────

    if (requete.method === 'POST' && chemin === '/monde/publier') {
      if (!sauvegardes) return json(reponse, 503, { erreur: 'sauvegardes indisponibles' })
      if (!sauvegardes.motDePasse) {
        /*
          ⚠️ PAS DE MOT DE PASSE = PUBLICATION FERMEE, jamais ouverte. Un
             serveur ou n'importe qui remplace le monde de la partie n'est
             pas un serveur.
        */
        return json(reponse, 403, { erreur: 'publication fermée : MONDE_MOTDEPASSE n’est pas défini' })
      }
      if (!sauvegardes.motDePasseValide(requete.headers['x-monde-motdepasse'])) {
        return json(reponse, 401, { erreur: 'mot de passe du monde refusé' })
      }

      try {
        const octets = await lireCorps(requete, TAILLE_MAX)
        const info = sauvegardes.publierMonde({
          octets,
          nom: url.searchParams.get('nom'),
          etiquette: url.searchParams.get('etiquette'),
          note: url.searchParams.get('note'),
          publiePar: url.searchParams.get('par'),
          fichiers: Number.parseInt(url.searchParams.get('fichiers') ?? '', 10),
        })
        session.annoncer(`Un nouveau monde a été publié : « ${info.nom} ».`)
        return json(reponse, 200, info)
      } catch (e) {
        return json(reponse, 400, { erreur: e.message })
      }
    }

    // ── Administration ──────────────────────────────────────────────────────

    if (chemin.startsWith('/admin')) {
      /*
        ⚠️ SANS CLE, LA ROUTE N'EXISTE PAS. Repondre 401 confirmerait a un
           curieux qu'il y a une porte derriere ce chemin.
      */
      if (!cleAdmin) return json(reponse, 404, { erreur: 'route inconnue' })
      if (!memeSecret(requete.headers['x-admin-cle'], cleAdmin)) {
        return json(reponse, 404, { erreur: 'route inconnue' })
      }

      if (requete.method === 'GET' && chemin === '/admin/etat') {
        return json(reponse, 200, {
          ...session.etat(),
          /*
            ⚠️ SAVOIR D'OU VIENT UN REGLAGE EST LA MOITIE DU DIAGNOSTIC. Un
               fichier `reglages.env` oublie sur un serveur expliquerait un
               comportement que le panneau ne montre pas ; la liste des cles
               qu'il a fournies le dit en une ligne.
          */
          reglagesDeFichier: config.reglagesDeFichier ?? [],
          avertissements: config.avertissements ?? [],
          transport: transport.rapport(),
          mesures: mesures ? mesures.rapport() : null,
          entites: entites ? entites.nombre : 0,
          creatures: pnj ? pnj.nombre : 0,
          identites: identites ? identites.nombre : 0,
          sanctions: moderation ? moderation.nombre : 0,
          ressources: ressources ? ressources.liste() : [],
          annuaire: annuaire ? annuaire.rapport() : null,
          temps: temps ? temps.instantane() : null,
        })
      }

      if (requete.method === 'GET' && chemin === '/admin/joueurs') {
        /*
          ⚠️ C'EST LA SEULE ROUTE QUI DONNE LES ADRESSES, ET ELLE EST DERRIERE
             LA CLE. L'hote en a besoin pour bannir ; personne d'autre.
        */
        return json(reponse, 200, {
          joueurs: [...session.joueurs.values()].map((j) => ({
            id: j.id,
            nom: j.nom,
            adresse: j.adresse,
            empreinte: j.empreinte,
            role: session.role(j),
            hote: j.hote,
            spectateur: j.spectateur,
            ping: j.ping,
            decalageMs: j.decalage,
            pos: j.pos,
            vie: j.vie,
            depuisS: Math.round((Date.now() - j.arriveLe) / 1000),
            faits: j.faits,
          })),
        })
      }

      if (requete.method === 'GET' && chemin === '/admin/sanctions') {
        return json(reponse, 200, { sanctions: moderation ? moderation.liste() : [] })
      }

      if (requete.method === 'GET' && chemin === '/admin/coffre') {
        return json(reponse, 200, {
          coffre: inventaires ? inventaires.contenu() : [],
          journal: inventaires ? inventaires.journalRecent(40) : [],
        })
      }

      if (requete.method === 'POST' && chemin === '/admin/commande') {
        try {
          const corps = JSON.parse((await lireCorps(requete, 4096)).toString('utf8'))
          const texte = String(corps.texte || '').slice(0, 240)
          if (!texte) return json(reponse, 400, { erreur: 'texte manquant' })

          /*
            ⚠️ LA COMMANDE S'EXECUTE AU NOM DE LA CONSOLE, PAS D'UN JOUEUR. Elle
               a tous les droits parce qu'elle vient de celui qui tient la
               machine — mais elle n'a ni position ni pion : les commandes qui
               visent « ici » n'ont rien a viser, et c'est normal.

            ⚠️ `console: true` EST POSE ICI, JAMAIS LU DANS UN PAQUET. C'est ce
               drapeau qui donne les droits ; s'il pouvait venir du reseau,
               n'importe qui serait proprietaire.
          */
          const operateur = {
            id: 0,
            nom: 'console',
            console: true,
            pos: { x: 0, y: 0, z: 0 },
            rot: { x: 0, y: 0, z: 0 },
            hote: true,
            spectateur: false,
            empreinte: null,
            ping: 0,
            faits: {},
            adresse: '127.0.0.1',
          }
          const { executer } = require('./commandes')
          const reponseTexte = executer(session, operateur, texte)
          return json(reponse, 200, { reponse: reponseTexte ?? 'fait' })
        } catch (e) {
          return json(reponse, 400, { erreur: e.message })
        }
      }

      if (requete.method === 'POST' && chemin === '/admin/annoncer') {
        try {
          const corps = JSON.parse((await lireCorps(requete, 4096)).toString('utf8'))
          const texte = String(corps.texte || '').slice(0, 240)
          if (!texte) return json(reponse, 400, { erreur: 'texte manquant' })
          session.annoncer(texte)
          return json(reponse, 200, { ok: true, joueurs: session.nombre })
        } catch (e) {
          return json(reponse, 400, { erreur: e.message })
        }
      }

      if (requete.method === 'POST' && chemin === '/admin/ressources/recharger') {
        if (!ressources) return json(reponse, 503, { erreur: 'ressources indisponibles' })
        const r = ressources.rechargerTout()
        return json(reponse, 200, r)
      }

      return json(reponse, 404, { erreur: 'route inconnue' })
    }

    if (requete.method !== 'GET') return json(reponse, 405, { erreur: 'methode refusee' })

    switch (chemin) {
      case '/':
      case '/info':
        return json(reponse, 200, {
          ...session.etat(),
          transport: transport.choisir().retenu,
          monde: sauvegardes && sauvegardes.infoMonde().present ? sauvegardes.infoMonde().nom : null,
          equipes: equipes ? equipes.nombre : 0,
          activites: activites ? activites.nombre : 0,
        })

      case '/joueurs':
        /*
          ⚠️ NI ADRESSE NI JETON. Cette route est publique : elle ne donne que
             ce qu'on accepterait d'afficher sur un site.
        */
        return json(reponse, 200, {
          joueurs: [...session.joueurs.values()].map((j) => ({
            nom: j.nom,
            hote: j.hote,
            spectateur: j.spectateur,
            ping: j.ping,
            equipe: equipes ? (equipes.equipeDe(j.id)?.nom ?? null) : null,
            depuisS: Math.round((Date.now() - j.arriveLe) / 1000),
          })),
        })

      case '/entites':
        /*
          ⚠️ NI PROPRIETAIRE, NI ETAT DETAILLE. Cette route est publique comme
             les autres : elle sert a voir combien d'entites vivent et ou, pas
             a lire ce que contient le coffre de quelqu'un.
        */
        if (!entites) return json(reponse, 200, { nombre: 0, entites: [] })
        return json(reponse, 200, {
          nombre: entites.nombre,
          entites: entites.toutes().map((e) => ({ id: e.id, type: e.type, pos: e.pos })),
        })

      case '/creatures':
        if (!pnj) return json(reponse, 200, { nombre: 0, creatures: [] })
        return json(reponse, 200, { nombre: pnj.nombre, creatures: pnj.toutes() })

      case '/equipes':
        return json(reponse, 200, equipes ? equipes.instantane() : { rev: 0, equipes: [] })

      case '/activites':
        return json(reponse, 200, activites ? activites.instantane() : { rev: 0, activites: [] })

      case '/coffre':
        return json(reponse, 200, inventaires ? inventaires.instantane() : { rev: 0, coffre: [] })

      case '/temps':
        return json(reponse, 200, temps ? temps.instantane() : monde.instantane())

      case '/transport':
        return json(reponse, 200, transport.rapport())

      case '/mesures':
        /*
          ⚠️ LES MESURES SONT PUBLIQUES PARCE QU'ELLES NE DISENT RIEN DE
             PERSONNE. Octets par seconde, duree de tick, memoire : de quoi
             juger un serveur avant d'y entrer.
        */
        return json(reponse, 200, mesures ? mesures.rapport() : { erreur: 'indisponibles' })

      case '/ressources':
        return json(reponse, 200, {
          nombre: ressources ? ressources.nombre : 0,
          ressources: ressources
            ? ressources.liste().map((r) => ({ nom: r.nom, version: r.version, description: r.description, active: r.active }))
            : [],
        })

      case '/monde':
        return json(reponse, 200, monde.instantane())

      case '/monde/info':
        if (!sauvegardes) return json(reponse, 503, { erreur: 'sauvegardes indisponibles' })
        return json(reponse, 200, sauvegardes.infoMonde())

      case '/monde/bundle': {
        if (!sauvegardes) return json(reponse, 503, { erreur: 'sauvegardes indisponibles' })

        /*
          ⚠️ UN SERVEUR PROTEGE PROTEGE AUSSI SON MONDE. Sans ca, le mot de
             passe de la partie ne servirait a rien : l'archive contient la
             partie elle-meme.
        */
        if (config.motDePasse && !memeSecret(url.searchParams.get('motdepasse'), config.motDePasse)) {
          return json(reponse, 401, { erreur: 'mot de passe du serveur requis' })
        }

        const cheminMonde = sauvegardes.cheminDuMonde()
        if (!cheminMonde) return json(reponse, 404, { erreur: 'aucun monde publié' })

        const info = sauvegardes.infoMonde()
        reponse.writeHead(200, {
          'Content-Type': 'application/zip',
          'Content-Length': info.taille,
          'Content-Disposition': 'attachment; filename="monde.zip"',
          'X-Monde-Empreinte': info.empreinte,
          'Cache-Control': 'no-store',
        })
        return fs.createReadStream(cheminMonde).pipe(reponse)
      }

      case '/sante':
        return json(reponse, 200, {
          ok: true,
          joueurs: session.joueurs.size,
          tick: session.tick,
          memoireMo: Math.round(process.memoryUsage().rss / 1048576),
          mondePublie: sauvegardes ? sauvegardes.infoMonde().present : false,
          joueursConnus: sauvegardes ? sauvegardes.nombreConnus() : 0,
          identitesConnues: identites ? identites.nombre : 0,
          ressourcesActives: ressources ? ressources.nombre : 0,
        })

      default:
        return json(reponse, 404, { erreur: 'route inconnue' })
    }
  })

  serveur.on('clientError', (_e, socket) => socket.destroy())
  serveur.on('error', (e) => journal.erreur(`TCP : ${e.message}`))

  return serveur
}

module.exports = { creerHttp }
