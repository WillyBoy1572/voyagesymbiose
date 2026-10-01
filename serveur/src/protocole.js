'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  PROTOCOLE — tout ce qui entre est hostile jusqu'a preuve du contraire
 * ═══════════════════════════════════════════════════════════════════════════
 *  Messages en JSON sur UDP. Lisible, debogable a l'oeil nu, et suffisant
 *  pour seize joueurs a 20 instantanes par seconde.
 *
 *  ⚠️ L'UDP N'A PAS DE CONNEXION : n'importe qui peut envoyer n'importe quoi
 *     depuis n'importe quelle adresse. D'ou le jeton de session remis a
 *     l'arrivee : sans lui, usurper un autre joueur ne couterait qu'une ligne
 *     de code a l'attaquant.
 *
 *  ⚠️ UN NOMBRE NON FINI EMPOISONNE TOUT. `NaN` ou `Infinity` dans une
 *     position se propage a tous les clients par l'instantane suivant et ne
 *     part plus jamais. On refuse a l'entree, pas apres.
 *
 *  ⚠️ POURQUOI DU JSON ET PAS DU BINAIRE. A seize joueurs et 20 Hz, un
 *     instantane JSON pese quelques kilo-octets : le reseau ne le sent pas, et
 *     on peut lire un paquet a l'oeil quand quelque chose cloche. Un format
 *     binaire ferait gagner environ 60 % de taille sur une ressource qui n'est
 *     pas rare, et couterait un decodeur a ecrire des deux cotes — dont un en
 *     Lua, sans bibliotheque. Le jour ou la taille devient le probleme, la
 *     conversion se fera ici, dans ce seul fichier.
 *
 *  ⚠️ LE PROTOCOLE EST VERSIONNE, ET LES ANCIENS CLIENTS ENTRENT QUAND MEME.
 *     Les champs ajoutes en v2 sont tous facultatifs : un client v1 perd la
 *     fonctionnalite, pas l'acces.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Au-dela, on jette sans meme tenter de lire : c'est du bruit ou une attaque. */
const TAILLE_MAX = 4096

const LIMITES = {
  nom: 24,
  chat: 240,
  commande: 240,
  version: 24,
  motDePasse: 128,
  cle: 48,
  valeur: 240,
  classe: 64,
  objet: 48,
  signature: 256,
  clePublique: 512,
}

/** Coordonnees plausibles. Le monde du jeu est grand, pas infini. */
const BORNE_MONDE = 1_000_000

/** Canaux de chat. Fermee : un canal inconnu ne doit pas devenir un canal libre. */
const CANAUX = ['global', 'local', 'equipe', 'prive']

function nombreFini(v, borne) {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= borne
}

/**
 * Nettoie une chaine venue du reseau.
 *
 * ⚠️ LES CARACTERES DE CONTROLE SONT RETIRES. Un retour a la ligne dans un nom
 *    de joueur casserait la console du panneau en deux lignes, et un retour
 *    chariot permettrait de faire croire a un message du serveur.
 */
function chaine(v, max) {
  if (typeof v !== 'string') return null
  const propre = v
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return propre ? propre.slice(0, max) : null
}

/**
 * Comme `chaine`, mais pour une donnee opaque — une cle, une signature. On ne
 * garde que l'alphabet base64url : rien d'autre n'a de sens ici, et tout le
 * reste serait une tentative d'injection.
 */
function opaque(v, max) {
  if (typeof v !== 'string') return null
  const propre = v.replace(/[^A-Za-z0-9+/=_-]/g, '')
  return propre ? propre.slice(0, max) : null
}

function vecteur(v, borne = BORNE_MONDE) {
  if (!v || typeof v !== 'object') return null
  const { x, y, z } = v
  if (!nombreFini(x, borne) || !nombreFini(y, borne) || !nombreFini(z, borne)) return null
  return { x, y, z }
}

/**
 * Une table de petites valeurs, bornee en nombre de cles et en taille.
 *
 * ⚠️ ON NE LAISSE PASSER NI OBJET NI TABLEAU IMBRIQUE. Une structure profonde
 *    envoyee par un client se retrouverait telle quelle dans l'instantane de
 *    tous les autres, et un seul paquet suffirait a les saturer.
 */
function petiteTable(brut, maxCles = 16) {
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) return null
  const sortie = {}
  let poses = 0
  for (const [k, v] of Object.entries(brut)) {
    if (poses >= maxCles) break
    const cle = String(k).slice(0, 24)
    const type = typeof v
    if (type === 'string') sortie[cle] = v.slice(0, LIMITES.valeur)
    else if (type === 'number' && Number.isFinite(v)) sortie[cle] = v
    else if (type === 'boolean') sortie[cle] = v
    else continue
    poses++
  }
  return sortie
}

/** Decode un paquet brut. Rend `null` si quoi que ce soit cloche. */
function decoder(tampon) {
  if (!tampon || tampon.length === 0 || tampon.length > TAILLE_MAX) return null
  let brut
  try {
    brut = JSON.parse(tampon.toString('utf8'))
  } catch {
    return null
  }
  if (!brut || typeof brut !== 'object' || Array.isArray(brut)) return null
  if (typeof brut.t !== 'string' || brut.t.length > 16) return null
  return brut
}

function encoder(objet) {
  return Buffer.from(JSON.stringify(objet), 'utf8')
}

/**
 * Valide un message selon son type et rend une forme sure, ou `null`.
 * Le serveur ne travaille QUE sur ce que cette fonction a laisse passer.
 */
function valider(brut) {
  switch (brut.t) {
    case 'bonjour': {
      const nom = chaine(brut.nom, LIMITES.nom)
      if (!nom) return null
      return {
        t: 'bonjour',
        nom,
        version: chaine(brut.version, LIMITES.version) ?? '?',
        protocole: Number.isInteger(brut.protocole) ? brut.protocole : 0,
        motDePasse: typeof brut.motDePasse === 'string' ? brut.motDePasse.slice(0, LIMITES.motDePasse) : '',
        /*
          ⚠️ LA PREUVE D'IDENTITE EST FACULTATIVE, PAS DECORATIVE. Absente, le
             joueur entre en anonyme et n'a droit a aucun role durable.
             Presente, elle est verifiee avant qu'on lui accorde quoi que ce
             soit.
        */
        cle: opaque(brut.cle, LIMITES.clePublique),
        ts: nombreFini(brut.ts, Number.MAX_SAFE_INTEGER) ? brut.ts : 0,
        sig: opaque(brut.sig, LIMITES.signature),
        /** Jeton rendu au depart : permet de reprendre sa place et son etat. */
        reprise: opaque(brut.reprise, LIMITES.cle),
        /** Ce que ce client sait faire : le serveur ne lui envoie pas le reste. */
        capacites: Array.isArray(brut.capacites)
          ? brut.capacites.slice(0, 16).map((c) => chaine(c, 24)).filter(Boolean)
          : [],
        /** Entrer en spectateur : on voit, on ne joue pas. */
        spectateur: brut.spectateur === true,
      }
    }

    case 'etat': {
      const pos = vecteur(brut.pos)
      if (!pos) return null
      // La rotation est facultative : un client qui ne la connait pas encore
      // vaut mieux qu'un client rejete.
      const rot = vecteur(brut.rot, 3600) ?? { x: 0, y: 0, z: 0 }
      /*
        ⚠️ LA VITESSE EST CE QUI FAIT MARCHER LES JAMBES. Les joueurs distants
           sont de vrais pions du jeu : ils portent son blueprint d'animation,
           et ce blueprint lit la vitesse du composant de mouvement. Sans elle
           ils glissent, immobiles, quelle que soit la distance parcourue.

           Facultative : un client plus ancien qui ne l'envoie pas reste
           accepte, il glisse simplement comme avant.
      */
      const vit = vecteur(brut.vit, 100000) ?? null
      return {
        t: 'etat',
        jeton: chaine(brut.jeton, LIMITES.cle),
        pos,
        rot,
        vit,
        seq: Number.isInteger(brut.seq) && brut.seq >= 0 ? brut.seq : 0,
        anim: chaine(brut.anim, 32) ?? null,
        /** Geste en cours : la main qui salue, le doigt qui pointe. */
        geste: chaine(brut.geste, 16) ?? null,
        /** Points de vie, si le mod a su les lire. `null` = inconnu, pas zero. */
        vie: nombreFini(brut.vie, 100000) ? brut.vie : null,
        /** Accroupi, nageant, en chute : ce que le mod a su lire. */
        posture: chaine(brut.posture, 16) ?? null,
        /** Horloge du client a l'envoi : sert a mesurer le decalage, pas a dater. */
        ts: nombreFini(brut.ts, Number.MAX_SAFE_INTEGER) ? brut.ts : 0,
      }
    }

    /*
      Intention portant sur une entite : ouvrir une porte, poser un objet,
      actionner une machine.

      ⚠️ LE CLIENT DEMANDE, IL N'AFFIRME PAS. Rien ici n'est applique tel
         quel : le serveur verifie l'autorite, puis decide. Et la cle de
         transaction garantit qu'un renvoi -- l'UDP duplique -- ne fabrique
         pas un deuxieme objet.
    */
    case 'entite': {
      const action = chaine(brut.action, 16)
      if (!action) return null
      if (!['creer', 'modifier', 'supprimer', 'prendre', 'rendre'].includes(action)) return null

      return {
        t: 'entite',
        jeton: chaine(brut.jeton, LIMITES.cle),
        action,
        cle: chaine(brut.cle, LIMITES.cle),
        id: Number.isInteger(brut.id) && brut.id > 0 ? brut.id : 0,
        type: chaine(brut.type, 24),
        pos: vecteur(brut.pos),
        rot: brut.rot && nombreFini(brut.rot.yaw, 3600) ? { yaw: brut.rot.yaw } : null,
        etat: petiteTable(brut.etat),
      }
    }

    /*
      Rapport de creatures par le joueur qui fait autorite.

      ⚠️ LA LISTE EST BORNEE DEUX FOIS : en nombre d'entrees ici, et en nombre
         retenu par le registre. Un seul paquet ne doit pas pouvoir remplir le
         monde de requins.
    */
    case 'pnj': {
      const action = chaine(brut.action, 16)
      if (!['rapport', 'retrait'].includes(action)) return null

      let liste = null
      if (action === 'rapport') {
        if (!Array.isArray(brut.liste)) return null
        liste = []
        for (const brute of brut.liste.slice(0, 64)) {
          if (!brute || typeof brute !== 'object') continue
          const cle = chaine(brute.cle, LIMITES.cle)
          const classe = chaine(brute.classe ?? brute.c, LIMITES.classe)
          const pos = vecteur(brute.pos)
          if (!cle || !classe || !pos) continue
          liste.push({
            cle,
            classe,
            pos,
            rot: brute.rot && nombreFini(brute.rot.yaw, 3600) ? { yaw: brute.rot.yaw } : null,
            vie: nombreFini(brute.vie, 100000) ? brute.vie : null,
            etat: chaine(brute.etat, 24),
          })
        }
      }

      return {
        t: 'pnj',
        jeton: chaine(brut.jeton, LIMITES.cle),
        action,
        liste,
        cle: chaine(brut.cle, LIMITES.cle),
      }
    }

    /*
      Inventaire : le miroir de ce qu'on porte, et les mouvements du coffre.

      ⚠️ `declarer` NE DONNE AUCUN DROIT. Dire qu'on porte mille lingots ne
         permet pas d'en deposer mille : le depot est un mouvement separe, et
         c'est au mod d'avoir vraiment retire l'objet du jeu avant de le
         demander.
    */
    case 'inv': {
      const action = chaine(brut.action, 16)
      if (!['declarer', 'deposer', 'retirer', 'rendre', 'voir'].includes(action)) return null

      let objets = null
      if (action === 'declarer') {
        if (!Array.isArray(brut.objets)) return null
        objets = []
        for (const o of brut.objets.slice(0, 80)) {
          if (!o || typeof o !== 'object') continue
          const nom = chaine(o.nom ?? o.n, LIMITES.objet)
          const nombre = Number(o.nombre ?? o.q)
          if (!nom || !Number.isFinite(nombre) || nombre <= 0) continue
          objets.push({ nom, nombre: Math.floor(nombre) })
        }
      }

      return {
        t: 'inv',
        jeton: chaine(brut.jeton, LIMITES.cle),
        action,
        cle: chaine(brut.cle, LIMITES.cle),
        nom: chaine(brut.nom, LIMITES.objet),
        nombre: Number.isFinite(brut.nombre) ? Math.floor(brut.nombre) : 0,
        objets,
      }
    }

    /*
      Un fait ponctuel : porte ouverte, alarme, tir, ping, geste.

      ⚠️ ON NE TRANSPORTE AUCUN SON NI AUCUNE ANIMATION. Juste le fait et
         l'endroit : chaque jeu joue ensuite ce qu'il a deja chez lui.
    */
    case 'evenement': {
      const genre = chaine(brut.genre, 16)
      if (!genre) return null
      return {
        t: 'evenement',
        jeton: chaine(brut.jeton, LIMITES.cle),
        genre,
        pos: vecteur(brut.pos),
        cible: chaine(brut.cible, LIMITES.classe),
        valeur:
          typeof brut.valeur === 'number' && Number.isFinite(brut.valeur)
            ? brut.valeur
            : chaine(brut.valeur, 48),
      }
    }

    case 'equipe': {
      const action = chaine(brut.action, 16)
      if (!['creer', 'rejoindre', 'quitter', 'pret'].includes(action)) return null
      return {
        t: 'equipe',
        jeton: chaine(brut.jeton, LIMITES.cle),
        action,
        nom: chaine(brut.nom, LIMITES.nom),
        valeur: brut.valeur === true,
      }
    }

    case 'activite': {
      const action = chaine(brut.action, 16)
      if (!['creer', 'demarrer', 'cocher', 'finir', 'oublier'].includes(action)) return null
      return {
        t: 'activite',
        jeton: chaine(brut.jeton, LIMITES.cle),
        action,
        id: Number.isInteger(brut.id) && brut.id > 0 ? brut.id : 0,
        numero: Number.isInteger(brut.numero) ? brut.numero : 0,
        titre: chaine(brut.titre, 80),
        etat: chaine(brut.etat, 16),
        etapes: Array.isArray(brut.etapes)
          ? brut.etapes.slice(0, 12).map((e) => chaine(e, 80)).filter(Boolean)
          : [],
        dureeMs: Number.isFinite(brut.dureeMs) ? Math.floor(brut.dureeMs) : 0,
      }
    }

    case 'chat': {
      const texte = chaine(brut.texte, LIMITES.chat)
      if (!texte) return null
      const canal = chaine(brut.canal, 12)
      return {
        t: 'chat',
        jeton: chaine(brut.jeton, LIMITES.cle),
        texte,
        canal: CANAUX.includes(canal) ? canal : 'global',
        a: chaine(brut.a, LIMITES.nom),
      }
    }

    case 'commande': {
      const texte = chaine(brut.texte, LIMITES.commande)
      if (!texte) return null
      return { t: 'commande', jeton: chaine(brut.jeton, LIMITES.cle), texte }
    }

    case 'ping':
      return {
        t: 'ping',
        jeton: chaine(brut.jeton, LIMITES.cle),
        ts: nombreFini(brut.ts, Number.MAX_SAFE_INTEGER) ? brut.ts : 0,
      }

    /** Ce que le mod a reussi a faire dans le jeu. Sert au diagnostic, a rien d'autre. */
    case 'sonde': {
      const faits = petiteTable(brut.faits, 32)
      if (!faits) return null
      return { t: 'sonde', jeton: chaine(brut.jeton, LIMITES.cle), faits }
    }

    case 'adieu':
      return { t: 'adieu', jeton: chaine(brut.jeton, LIMITES.cle) }

    default:
      return null
  }
}

module.exports = {
  decoder,
  encoder,
  valider,
  chaine,
  opaque,
  vecteur,
  petiteTable,
  TAILLE_MAX,
  CANAUX,
}
