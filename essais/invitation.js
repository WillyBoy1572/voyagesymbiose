'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LES LIENS D'INVITATION TIENNENT-ILS ?
 * ═══════════════════════════════════════════════════════════════════════════
 *      node essais/invitation.js
 *
 *  ⚠️ UN LIEN SE CLIQUE SANS RÉFLÉCHIR. C'est précisément pour ça qu'il doit
 *     être le code le plus méfiant du lanceur : tout ce qui n'est pas exactement
 *     une adresse ou un billet doit ressortir `null`, et rien d'autre.
 */

const { lire, fabriquer, dansLesArguments } = require('../src/invitation')
const { comparerVersions } = require('../src/maj')
const { expurger } = require('../src/soutien')

let echecs = 0
let essais = 0

function ok(condition, libelle, detail = '') {
  essais++
  if (condition) {
    console.log(`  ✔ ${libelle}`)
  } else {
    echecs++
    console.log(`  ✘ ${libelle}${detail ? ` — ${detail}` : ''}`)
  }
}

function titre(texte) {
  console.log('\n── ' + texte + ' ' + '─'.repeat(Math.max(2, 52 - texte.length)))
}

titre('Ce qu’un lien doit donner')

const a = lire('voyage://join/144.217.162.237:30158')
ok(a?.hote === '144.217.162.237' && a?.port === 30158, 'une adresse avec son port', JSON.stringify(a))
ok(a?.protege === false, 'et rien ne dit qu’elle est protégée')

const b = lire('voyage://join/voyage.example.ca')
ok(b?.hote === 'voyage.example.ca' && b?.port === 7777, 'un nom d’hôte sans port prend 7777', JSON.stringify(b))

const c = lire('voyage://join/144.217.162.237:30158?protege=1')
ok(c?.protege === true, 'le lien peut annoncer qu’un mot de passe sera demandé')

const d = lire('voyage://billet/abcd2345')
ok(d?.billet === 'ABCD2345', 'un billet est mis en majuscules', JSON.stringify(d))

const e = lire('VOYAGE://BILLET/ab-cd23')
ok(e?.billet === 'ABCD23', 'et nettoyé de tout ce qui n’est ni lettre ni chiffre', JSON.stringify(e))

/*
  ⚠️ UN ESPACE VEUT DIRE LIEN CASSÉ, pas « lien à rafistoler ». Recoller les
     morceaux de part et d'autre donnerait un billet que personne n'a écrit.
*/
ok(lire('voyage://billet/ab cd') === null, 'un billet coupé par un espace est refusé')

titre('Ce qu’un lien ne doit JAMAIS donner')

for (const mauvais of [
  '',
  'https://caretakermp.symbioseheritage.ca/',
  'voyage://',
  'voyage://join/',
  'voyage://autre/truc',
  'voyage://join/144.217.162.237:99999',
  'voyage://join/144.217.162.237:0',
  'voyage://join/pas valide',
  'voyage://join/' + 'a'.repeat(300),
  'voyage://billet/!!!!',
  'javascript:alert(1)',
  'voyage://join/..\\..\\windows\\system32',
]) {
  ok(lire(mauvais) === null, `refusé : « ${mauvais.slice(0, 40) || '(vide)' } »`, JSON.stringify(lire(mauvais)))
}

/*
  ⚠️ LE PIÈGE LE PLUS PROBABLE : un mot de passe glissé dans le lien. Même si
     quelqu'un en met un, la lecture ne doit JAMAIS en ressortir un — sinon il
     finirait dans un journal, un historique ou un presse-papiers partagé.
*/
const avecMdp = lire('voyage://join/1.2.3.4:7777?mdp=secret&motdepasse=secret')
ok(
  avecMdp !== null && !JSON.stringify(avecMdp).toLowerCase().includes('secret'),
  'un mot de passe glissé dans un lien n’en ressort pas',
  JSON.stringify(avecMdp),
)

titre('Fabriquer un lien')

ok(
  fabriquer({ hote: '144.217.162.237', port: 30158 }) === 'voyage://join/144.217.162.237:30158',
  'une adresse se met en lien',
)
ok(
  fabriquer({ hote: '1.2.3.4', port: 7777, protege: true }) === 'voyage://join/1.2.3.4:7777?protege=1',
  'et peut annoncer un mot de passe sans le donner',
)
ok(fabriquer({ billet: 'abcd2345' }) === 'voyage://billet/ABCD2345', 'un billet aussi')
ok(fabriquer({ hote: 'ça ne va pas', port: 7777 }) === null, 'une adresse douteuse ne fabrique rien')
ok(fabriquer({ hote: '1.2.3.4', port: 70000 }) === null, 'un port impossible non plus')

// Un aller-retour : ce qu'on fabrique doit se relire à l'identique.
const lien = fabriquer({ hote: '144.217.162.237', port: 30158, protege: true })
const relu = lire(lien)
ok(
  relu?.hote === '144.217.162.237' && relu?.port === 30158 && relu?.protege === true,
  'aller-retour : ce qu’on fabrique se relit à l’identique',
  lien,
)

titre('Dans une ligne de commande')

ok(
  dansLesArguments(['C:\\x\\Voyage.exe', '--une-option', 'voyage://billet/XYZ23'])?.billet === 'XYZ23',
  'le lien est trouvé au milieu des arguments',
)
ok(dansLesArguments(['C:\\x\\Voyage.exe']) === null, 'et son absence ne rend rien')

titre('Comparaison de versions')

/*
  ⚠️ « 0.10.0 » EST PLUS RÉCENT QUE « 0.9.0 », mais plus petit en ordre
     alphabétique. Une comparaison de chaînes dirait au joueur qu'il est à jour
     pendant des mois.
*/
ok(comparerVersions('0.10.0', '0.9.0') === 1, '0.10.0 est plus récent que 0.9.0')
ok(comparerVersions('0.7.0', '0.7.0') === 0, 'deux fois la même version sont égales')
ok(comparerVersions('0.6.6', '0.7.0') === -1, '0.6.6 est plus ancien que 0.7.0')
ok(comparerVersions('1.0.0', '0.99.99') === 1, '1.0.0 bat 0.99.99')

titre('Le pack de soutien expurge')

for (const ligne of [
  'motdepasse=abc',
  'X-Admin-Cle: 1234',
  'jeton de reprise : abcdef',
  'SERVER_PASSWORD=truc',
]) {
  ok(expurger(ligne).startsWith('[ligne retirée'), `retirée : « ${ligne.slice(0, 30)} »`)
}
ok(expurger('connecté à « Voyage Public 1 »') === 'connecté à « Voyage Public 1 »', 'une ligne ordinaire passe')

console.log('\n' + '─'.repeat(58))
console.log(echecs === 0 ? `TOUT PASSE — ${essais} vérifications` : `${echecs} ÉCHEC(S) sur ${essais}`)
process.exit(echecs ? 1 : 0)
