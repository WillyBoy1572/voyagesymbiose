'use strict'

/**
 * Journal de console.
 *
 * ⚠️ TOUT PASSE PAR ICI, JAMAIS `console.log` DIRECTEMENT. Le panneau
 *    d'hebergement lit cette sortie ligne par ligne : une ligne horodatee et
 *    prefixee se retrouve dans la console du client, une ligne sauvage se
 *    perd dans le bruit.
 *
 * ⚠️ `server_listening` EST UN MOT-CLE, PAS UNE PHRASE. L'egg Pterodactyl
 *    guette exactement cette chaine pour passer le serveur de « demarrage » a
 *    « en ligne ». Ne jamais la traduire ni la decorer.
 */

function horodatage() {
  return new Date().toISOString().slice(11, 19)
}

function ecrire(niveau, message) {
  process.stdout.write(`[${horodatage()}] [${niveau}] ${message}\n`)
}

module.exports = {
  info: (m) => ecrire('info', m),
  avis: (m) => ecrire('avis', m),
  erreur: (m) => ecrire('ERREUR', m),
  /** Le signal attendu par l'hebergeur. */
  pret: () => process.stdout.write('server_listening\n'),
}
