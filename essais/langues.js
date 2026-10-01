'use strict'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  LES TROIS LANGUES SE TIENNENT-ELLES ?
 * ═══════════════════════════════════════════════════════════════════════════
 *  ⚠️ UNE CLE OUBLIEE NE PLANTE PAS. Elle retombe sur le francais, et le
 *     joueur anglophone voit une phrase francaise au milieu de sa page sans
 *     qu'aucune erreur n'apparaisse nulle part. Seul un essai le voit.
 *
 *  ⚠️ LE PROCESSUS PRINCIPAL FABRIQUE DES CLES QUI N'EXISTENT PEUT-ETRE PAS.
 *     `dit('jrn.truc')` et `souci('err.truc', …)` sont ecrits a la main : on
 *     verifie donc que chaque cle citee dans `src/` a bien une traduction.
 */

const fs = require('node:fs')
const path = require('node:path')

const RACINE = path.join(__dirname, '..')

let echecs = 0
const ok = (c, l, d = '') => {
  console.log(`  ${c ? '✔' : '✘'} ${l}${c ? '' : ` — ${d}`}`)
  if (!c) echecs++
}

console.log('\n── Les trois langues ' + '─'.repeat(38))

// On evalue `langues.js` tel quel : c'est un script classique, pas un module.
const source = fs.readFileSync(path.join(RACINE, 'ui', 'langues.js'), 'utf8')
const bac = { document: { documentElement: {}, querySelectorAll: () => [] } }
const fabrique = new Function(
  'document',
  `${source}; return { LANGUES_TEXTES, LANGUES_NOMS, T, LANGUES_appliquer }`,
)
const { LANGUES_TEXTES, LANGUES_NOMS, T, LANGUES_appliquer } = fabrique(bac.document)

const langues = Object.keys(LANGUES_TEXTES)
ok(langues.join(',') === 'fr,en,es', 'trois langues présentes', langues.join(','))
ok(
  Object.keys(LANGUES_NOMS).join(',') === langues.join(','),
  'chaque langue a un nom affichable',
  Object.keys(LANGUES_NOMS).join(','),
)

const reference = Object.keys(LANGUES_TEXTES.fr)
ok(reference.length === new Set(reference).size, 'aucune clé française en double')

for (const langue of langues.slice(1)) {
  const cles = Object.keys(LANGUES_TEXTES[langue])
  const manquantes = reference.filter((c) => !cles.includes(c))
  const enTrop = cles.filter((c) => !reference.includes(c))
  ok(manquantes.length === 0, `« ${langue} » ne manque aucune clé`, manquantes.slice(0, 5).join(', '))
  ok(enTrop.length === 0, `« ${langue} » n’a pas de clé orpheline`, enTrop.slice(0, 5).join(', '))
}

/*
  Les marqueurs {ainsi} doivent etre les memes partout : une traduction qui
  oublie {nom} affiche une phrase amputee, sans la moindre erreur.
*/
const marqueurs = (t) => (t.match(/\{[a-zA-Z]+\}/g) ?? []).sort().join(',')
let ecarts = []
for (const cle of reference) {
  for (const langue of langues.slice(1)) {
    const a = marqueurs(LANGUES_TEXTES.fr[cle])
    const b = marqueurs(LANGUES_TEXTES[langue][cle] ?? '')
    if (a !== b) ecarts.push(`${cle} (${langue}: ${b || 'rien'} ≠ ${a || 'rien'})`)
  }
}
ok(ecarts.length === 0, 'les marqueurs {…} concordent dans les trois langues', ecarts.slice(0, 4).join(' · '))

// ── Les cles citees par le processus principal existent-elles ? ─────────────

const citees = new Set()
for (const f of fs.readdirSync(path.join(RACINE, 'src'))) {
  if (!f.endsWith('.js')) continue
  const texte = fs.readFileSync(path.join(RACINE, 'src', f), 'utf8')
  for (const m of texte.matchAll(/(?:dit|souci)\(\s*'([^']+)'/g)) citees.add(m[1])
  for (const m of texte.matchAll(/cle:\s*'([^']+)'/g)) citees.add(m[1])
}
const orphelines = [...citees].filter((c) => LANGUES_TEXTES.fr[c] === undefined)
ok(orphelines.length === 0, `les ${citees.size} clés citées dans src/ sont traduites`, orphelines.join(', '))

// Idem pour le pont, qui porte son propre petit dictionnaire.
const pont = fs.readFileSync(path.join(RACINE, 'pont', 'pont.js'), 'utf8')
const citeesPont = new Set([...pont.matchAll(/M\('([a-zA-Z]+)'/g)].map((m) => m[1]))
const bloc = pont.slice(pont.indexOf('const MOTS'), pont.indexOf('const langue'))
const manquePont = [...citeesPont].filter(
  (c) => (bloc.match(new RegExp(`\\b${c}:`, 'g')) ?? []).length < 3,
)
ok(manquePont.length === 0, `les ${citeesPont.size} mots du pont existent en 3 langues`, manquePont.join(', '))

// ── Le remplacement fonctionne-t-il vraiment ? ──────────────────────────────

LANGUES_appliquer('en')
ok(T('jrn.modPose', { nom: 'VoyageLien' }).includes('VoyageLien'), 'les valeurs sont bien insérées')
ok(!T('jrn.modPose', { nom: 'X' }).includes('{'), 'aucun marqueur ne reste visible')
ok(T('nav.serveurs') === 'Servers', 'la langue choisie est bien celle rendue', T('nav.serveurs'))
LANGUES_appliquer('fr')
ok(T('nav.serveurs') === 'Serveurs', 'et on peut revenir au français', T('nav.serveurs'))

/*
  ⚠️ LA PAGE CITE DES CLES QUE `src/` NE CITE PAS. Jusqu'ici le banc ne lisait
     que le processus principal : six cles utilisees par `ui/app.js` manquaient
     dans les trois langues sans que rien ne le dise, et elles se seraient
     affichees telles quelles a l'ecran du joueur.
*/
{
  const app = fs.readFileSync(path.join(RACINE, 'ui', 'app.js'), 'utf8')
  const citees = new Set()
  for (const m of app.matchAll(/\bT\(\s*'([a-zA-Z0-9_.]+)'/g)) citees.add(m[1])
  const manquantes = [...citees].filter((c) => LANGUES_TEXTES.fr[c] === undefined)
  ok(
    manquantes.length === 0,
    `les ${citees.size} clés citées dans ui/app.js sont traduites`,
    manquantes.slice(0, 8).join(', '),
  )
}

/*
  ⚠️ UNE CLE QUE PLUS PERSONNE N'APPELLE RESTE TRADUITE EN TROIS LANGUES, et
     fait croire a une fonctionnalite qui n'existe plus. Huit traînaient : des
     restes de versions où le billet se copiait à la main. Le banc du site le
     vérifiait déjà ; celui du lanceur, non.
*/
{
  const sources = ['ui/app.js', 'ui/index.html', ...fs
    .readdirSync(path.join(RACINE, 'src'))
    .filter((f) => f.endsWith('.js'))
    .map((f) => path.join('src', f))]
  const corpus = sources
    .map((f) => { try { return fs.readFileSync(path.join(RACINE, f), 'utf8') } catch { return '' } })
    .join('\n')
  const orphelines = Object.keys(LANGUES_TEXTES.fr).filter(
    (c) => !corpus.includes(`'${c}'`) && !corpus.includes(`"${c}"`),
  )
  ok(
    orphelines.length === 0,
    'aucune clé ne traîne sans personne pour l’appeler',
    orphelines.join(', '),
  )
}

console.log('\n' + (echecs ? `${echecs} ÉCHEC(S)` : 'TOUT PASSE'))
process.exit(echecs ? 1 : 0)
