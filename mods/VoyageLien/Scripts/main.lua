--[[
═══════════════════════════════════════════════════════════════════════════
  VOYAGE — LIEN AVEC LE SERVEUR
═══════════════════════════════════════════════════════════════════════════
  Deux sens :
    ENVOI      position, vitesse, vie, interactions, creatures, inventaire.
    RECEPTION  les autres joueurs, les creatures, l'heure, les faits.

  ⚠️ LE LUA D'UE4SS N'A PAS DE SOCKETS. Il ne peut ni ouvrir une connexion
     UDP ni en lire une. Il sait par contre ouvrir un FICHIER — et sous
     Windows un tube nomme s'ouvre comme un fichier. On ecrit donc dans
     le tube, et `pont.js` fait le reseau.

  ⚠️ ON NE LIT PAS LE TUBE, ON LIT UN FICHIER. `f:read()` sur un tube BLOQUE
     tant que rien n'arrive — et ce blocage a lieu dans le fil de jeu : le
     jeu se fige. Le pont depose donc ce qu'il a a dire dans un fichier
     qu'on relit sans jamais attendre.

  ⚠️ ON N'ECRIT PAS DANS LE TUBE DEPUIS UNE TOUCHE. Une ecriture sur un tube
     nomme BLOQUE tant que personne ne lit a l'autre bout. Les touches
     DEPOSENT, le battement envoie.

  ⚠️ TOUT EST EN pcall. Une erreur Lua dans un mod UE4SS peut figer le jeu.

  ⚠️ TOUT CE QUI TOUCHE AU JEU EST UN ESSAI, ET CHAQUE ESSAI DIT S'IL A
     REUSSI. Je ne peux pas lancer le jeu : plutot que de supposer qu'une
     fonction existe, on l'essaie, on retient ce qui a marche, et on
     l'envoie au serveur (`/sonde` le montre). C'est ce qui permet de
     corriger sans dix allers-retours.
═══════════════════════════════════════════════════════════════════════════
]]

local NOM = "VoyageLien"
local TUBE = "\\\\.\\pipe\\voyage-lien"
local PERIODE_MS = 100          -- 10 envois par seconde
local ATTENTE_MS = 2000         -- au menu, ou sans pont : on regarde moins souvent
local LISSAGE = 0.35            -- repli quand il n'y a pas de quoi interpoler

--[[
  Retard d'affichage des autres joueurs, en millisecondes.

  ⚠️ ON AFFICHE LE PASSE, ET C'EST VOULU. Afficher la derniere position recue
     veut dire sauter des qu'un paquet manque. En gardant 150 ms de retard, on
     a presque toujours DEUX positions qui encadrent l'instant affiche : on
     interpole entre elles, et le mouvement reste continu meme si un paquet se
     perd.
]]
local RETARD_RENDU_MS = 150

--- Au-dela, on cesse d'extrapoler : mieux vaut s'arreter que partir au loin.
local EXTRAPOLATION_MAX_MS = 500

--[[
  Toutes les combien de MILLISECONDES l'hote envoie son recensement.

  ATTENTION : EN SECONDES, LES CREATURES SAUTAIENT. `os.time()` n a qu une
  resolution d une seconde ; a ce rythme un requin se teleporte d un bond toutes
  les deux secondes chez les autres. On compte en millisecondes sur notre propre
  horloge, et deux fois par seconde suffit pour que l interpolation ait de quoi
  travailler.
]]
local RECENSEMENT_MS = 500

--[[
  Retard d affichage des creatures.

  ATTENTION : PLUS LONG QUE CELUI DES JOUEURS, ET C EST VOULU. Les joueurs
  arrivent dix fois par seconde, les creatures deux fois : il faut un retard plus
  grand pour avoir presque toujours deux positions qui encadrent l instant
  affiche. Trop court, et on extrapole en permanence.
]]
local RETARD_CREATURES_MS = 600

--- Toutes les combien de secondes on balaye le monde pour trouver les creatures.
local BALAYAGE_S = 10

--- Toutes les combien de secondes on declare son inventaire.
local INVENTAIRE_S = 5

local sortie = nil
local parFichier = false
local envoyes = 0
local derniereAlerte = 0
local dernierEtat = ""

--- Horloge a nous, en millisecondes. Monotone, avancee par le battement.
local horlogeMs = 0

--- Les pions distants, par identifiant de joueur.
local fantomes = {}
local classeFantome = nil
local fichierAutres = nil
local rendezVous = nil
local plainteSpawn = false

--- Suis-je l'hote ? Le pont nous le dit ; seul l'hote recense les creatures.
local jeSuisHote = false

--- Ce que le mod a reussi a faire. Envoye au serveur, lisible par /sonde.
local faits = {}
local faitsEnvoyes = ""

--- Les creatures du monde local, trouvees une fois puis suivies.
local creatures = {}
local dernierRecensement = 0
local dernierBalayage = 0
local dernierInventaire = 0

--[[
  LE MIROIR DES CREATURES.

  ATTENTION : LE JEU FAIT APPARAITRE SES CREATURES CHEZ CHACUN, SEPAREMENT.
  Rien ne relie le requin de l un a celui de l autre : ce ne sont pas les memes
  acteurs, ils n ont pas le meme identifiant, et aucune de leurs graines
  aleatoires n est partagee. Pour voir LE MEME requin il n y a qu un chemin :
  masquer les siennes et afficher celles de l hote.

  Trois modes, et le joueur peut en changer en jeu (F2) :
    miroir   on masque les siennes, on affiche celles de l hote.
    annonce  on ne touche a rien, on affiche juste ce que l hote signale.
    rien     on ignore les creatures du serveur.

  ATTENTION : ON MASQUE, ON NE DETRUIT PAS. Detruire un acteur que le jeu suit
  casse ses generateurs : ils gardent des references, et certains relancent une
  apparition en boucle quand leur creature disparait sans raison. Masquer +
  couper la collision + couper le tick donne le meme resultat a l ecran, se
  defait en une ligne, et ne touche a rien que le jeu compte.
]]
local modeCreatures = "miroir"

--- Les creatures locales qu on a masquees : cle -> acteur, pour pouvoir les rendre.
local masquees = {}

--- Les fantomes de creatures, par identifiant du serveur.
local fantomesCreatures = {}

--[[
  Les classes de creatures vues localement.

  ATTENTION : C EST LA CLE DE TOUT LE MIROIR. On ne connait aucun chemin d asset
  (`/Game/.../BP_NPC_Shark.BP_NPC_Shark_C`) et les deviner casserait a la
  premiere mise a jour du jeu. Mais le jeu du non-hote fait apparaitre SES
  propres requins : on prend la classe sur l un d eux avant de le masquer, et on
  s en sert pour faire apparaitre ceux de l hote. Zero nom devine.
]]
local classesCreatures = {}

--- Ce que le serveur nous a dit en dernier.
local heureServeur = nil
local coffreServeur = {}

--[[
  LES REGLAGES DES PLAQUES DE NOM.

  ATTENTION : C EST UN CHOIX LOCAL, COMME LE MIROIR. Ce qu un joueur affiche
  au-dessus des tetes ne regarde que lui ; le serveur n en connait pas un mot.
  Le lanceur les pose, le pont les porte, le mod les applique.

  ATTENTION : LA PORTEE EST EN METRES DANS L INTERFACE, EN CENTIMETRES ICI.
  Unreal compte en centimetres ; melanger les deux donne des plaques qui
  disparaissent a un metre ou qui ne disparaissent jamais.
]]
local plaques = { noms = true, distance = true, ping = false, vie = false, portee = 8000 }

--- Mode debug : identifiants, modes de rendu, compteurs. F1 bascule.
local debug = false

--- Ce qu'on a a envoyer au pont, vide par le battement.
local aEnvoyer = {}

-- ═══════════════════════════════════════════════════════════════════════════
--  OUTILS
-- ═══════════════════════════════════════════════════════════════════════════

local function sur(f, repli)
    local ok, r = pcall(f)
    if ok and r ~= nil then return r end
    return repli
end

local function estValide(o)
    return o ~= nil and sur(function() return o:IsValid() end, false)
end

--[[
  ⚠️ LA CONSOLE D'UE4SS NE REND PAS L'UTF-8. Chaque caractere accentue y
     ressort en « ? » : « en partie : X — envoi » devenait « X ? envoi ».
     On filtre au dernier moment, dans les deux sorties, plutot que de
     surveiller chaque phrase — d'autant que certaines viennent du serveur
     ou du lanceur, et qu'on ne les ecrit pas toutes nous-memes.
]]
local REMPLACEMENTS = {
    ["à"] = "a", ["â"] = "a", ["ä"] = "a", ["ç"] = "c",
    ["é"] = "e", ["è"] = "e", ["ê"] = "e", ["ë"] = "e",
    ["î"] = "i", ["ï"] = "i", ["ô"] = "o", ["ö"] = "o",
    ["ù"] = "u", ["û"] = "u", ["ü"] = "u", ["ÿ"] = "y",
    ["É"] = "E", ["È"] = "E", ["Ê"] = "E", ["À"] = "A", ["Ç"] = "C",
    ["«"] = '"', ["»"] = '"', ["’"] = "'", ["‘"] = "'",
    ["“"] = '"', ["”"] = '"', ["—"] = "-", ["–"] = "-",
    ["…"] = "...", ["·"] = "-", ["°"] = "deg", ["€"] = "EUR",
}

local function ascii(texte)
    local s = tostring(texte)
    for de, vers in pairs(REMPLACEMENTS) do
        s = s:gsub(de, vers)
    end
    -- Ce qui reste hors ASCII devient un point : illisible vaut mieux que faux.
    s = s:gsub("[\128-\255]", ".")
    return s
end

local function journal(texte)
    print("[" .. NOM .. "] " .. ascii(texte) .. "\n")
end

--- N'annonce un changement d'etat qu'une fois, pas 10 fois par seconde.
local function annoncer(texte)
    if texte ~= dernierEtat then
        dernierEtat = texte
        journal(texte)
    end
end

local function nomClasse(o)
    return sur(function() return o:GetClass():GetFName():ToString() end, "?")
end

local function dossierTemp()
    return os.getenv("TEMP") or os.getenv("TMP") or "."
end

--[[
  Retient un fait, et le dit une seule fois dans la console.

  ⚠️ C'EST LA SEULE FACON DE SAVOIR CE QUI MARCHE VRAIMENT. Chaque mecanisme
     qui touche au jeu — animation, nameplate, crochet, inventaire — passe par
     ici. Le serveur recoit la table, et `/sonde` l'affiche : plus besoin de
     demander « est-ce que les jambes bougent chez toi ? ».
]]
local function noterFait(cle, valeur)
    local v = tostring(valeur)
    if faits[cle] == v then return end
    faits[cle] = v
    journal("fait : " .. cle .. " = " .. v)
end

-- ═══════════════════════════════════════════════════════════════════════════
--  ACCES AU JEU, ET ECRAN
-- ═══════════════════════════════════════════════════════════════════════════

--[[
  ⚠️ CES COULEURS ET `ecran` SONT DECLARES ICI, TOUT EN HAUT, ET CE N'EST PAS
     DU RANGEMENT. En Lua, un `local` n'existe qu'APRES sa ligne : une fonction
     ecrite plus haut qui appelle `ecran` appelle en realite une variable
     globale nulle, et plante. C'etait le cas dans la version precedente :
     `suivreLesAutres` appelait `ecran(...)` declare 150 lignes plus bas,
     l'erreur etait avalee par le `pcall` du battement, et la boucle qui retire
     les joueurs partis ne s'executait JAMAIS — les entrees s'accumulaient et la
     console repetait « est parti » dix fois par seconde.
]]
local BLANC = { R = 0.85, G = 0.87, B = 0.83, A = 1.0 }
local ORANGE = { R = 0.82, G = 0.35, B = 0.20, A = 1.0 }
local VERT = { R = 0.07, G = 0.70, B = 0.33, A = 1.0 }
local OR = { R = 0.78, G = 0.62, B = 0.25, A = 1.0 }

local fichierMessages = nil
local dernierMessageVu = ""

local function aides()
    return sur(function() return require("UEHelpers") end, nil)
end

local function monde()
    local h = aides()
    if h then
        local m = sur(function() return h:GetWorld() end, nil)
        if estValide(m) then return m end
    end
    return sur(function() return FindFirstOf("World") end, nil)
end

local function kismet()
    return sur(function() return StaticFindObject("/Script/Engine.Default__KismetSystemLibrary") end, nil)
end

--- Le controleur du joueur local, ou nil.
local function controleur()
    local pc = sur(function() return FindFirstOf("PlayerController") end, nil)
    if not estValide(pc) then return nil end
    return pc
end

--[[
  Ecrit une ligne a l'ecran.

  ⚠️ LE JEU A SON PROPRE SYSTEME DE MESSAGES, ET IL EST MEILLEUR QUE LE NOTRE.
     `VoyagePlayerController:AddMessageBySlot` est une fonction DU JEU — la
     sonde l'a trouvee. Son texte s'affiche comme les messages du jeu, a la
     bonne place, avec la bonne police. On l'essaie d'abord. Si elle n'accepte
     pas nos arguments, on retombe sur `PrintString` de Kismet : du texte de
     debogage dans un coin, mais qui marche partout.
]]
--[[
  TROIS LANGUES, DANS LE JEU

  Ce que le mod ecrit a l ecran suit la langue choisie dans le lanceur : le
  pont la lui envoie a chaque lot, et le mod la garde.

  ATTENTION : LE FRANCAIS EST LE SEUL REPLI. Une cle absente d une traduction
  retombe sur le francais plutot que de laisser un trou. Une cle absente
  partout rend la cle elle meme : c est laid, et c est fait pour se voir.

  ATTENTION : PAS D ACCENTS DANS CE FICHIER. Le jeu affiche par
  AddMessageBySlot, qui ne rend pas les caracteres accentues de maniere
  fiable ; tout passe deja par ascii(). On ecrit donc sans accent plutot que
  d afficher des carres a la place des lettres.
]]
local langue = "fr"

local TEXTES = {
    fr = {
        pasConnecte = "pas connecte : ouvre le lanceur et clique << Connecter >>.",
        lienCoupe = "le lien s'est coupe.",
        estLa = "{1} est la.",
        estParti = "{1} est parti.",
        creatures = "creatures : {1}",
        seul = "tu es seul pour l'instant.",
        avecToi = "{1} avec toi : {2}",
        pasEnPartie = "pas en partie.",
        personneNiRdv = "personne en jeu et aucun point de rendez-vous. Que quelqu'un appuie sur F3 la ou vous voulez vous retrouver.",
        tuArrives = "tu arrives pres de {1}.",
        deplacementEchoue = "le deplacement a echoue. Envoie-moi cette ligne.",
        pointMarque = "point marque pour tout le monde.",
        tuFaisSigne = "tu fais signe.",
        coffreVide = "le coffre commun est vide. Depuis le lanceur, onglet Coffre, tu peux y deposer.",
        coffre = "coffre commun : {1}",
        aide = "F1 debug - F2 creatures ({1}) - F3 point de retrouvailles - F4 aide - F5 rejoindre - F6 qui est la - F7 installer le monde - F9 publier - F10 coffre - F11 marquer - F12 salut",
        debugFerme = "debug ferme.",
        rdvPose = "point de retrouvailles pose ici.",
        demandeInstaller = "demande envoyee au lanceur : installer le monde du serveur...",
        demandePublier = "demande envoyee au lanceur : publier ta partie...",
        debugJoueurs = "joueurs {1}",
        debugCreatures = "creatures {1} (masquees {2}, classes {3})",
        debugMode = "mode {1}",
        debugHote = " / hote",
        debugRendu = "rendu {1}",
        debugEnvoyes = "envoyes {1}",
        debugHorloge = "horloge {1}s",
    },
    en = {
        pasConnecte = "not connected: open the launcher and click “Connect”.",
        lienCoupe = "the link has dropped.",
        estLa = "{1} is here.",
        estParti = "{1} has left.",
        creatures = "creatures: {1}",
        seul = "you are alone for now.",
        avecToi = "{1} with you: {2}",
        pasEnPartie = "not in a game.",
        personneNiRdv = "nobody in game and no rally point. Someone press F3 where you want to meet.",
        tuArrives = "you arrive near {1}.",
        deplacementEchoue = "the move failed. Send me this line.",
        pointMarque = "point marked for everyone.",
        tuFaisSigne = "you wave.",
        coffreVide = "the shared chest is empty. From the launcher, Chest tab, you can drop things in.",
        coffre = "shared chest: {1}",
        aide = "F1 debug - F2 creatures ({1}) - F3 rally point - F4 help - F5 join - F6 who is here - F7 install the world - F9 publish - F10 chest - F11 mark - F12 wave",
        debugFerme = "debug closed.",
        rdvPose = "rally point set here.",
        demandeInstaller = "request sent to the launcher: install the server world...",
        demandePublier = "request sent to the launcher: publish your save...",
        debugJoueurs = "players {1}",
        debugCreatures = "creatures {1} (hidden {2}, classes {3})",
        debugMode = "mode {1}",
        debugHote = " / host",
        debugRendu = "render {1}",
        debugEnvoyes = "sent {1}",
        debugHorloge = "clock {1}s",
    },
    es = {
        pasConnecte = "sin conexion: abre el lanzador y haz clic en «Conectar».",
        lienCoupe = "el enlace se ha cortado.",
        estLa = "{1} esta aqui.",
        estParti = "{1} se ha ido.",
        creatures = "criaturas: {1}",
        seul = "estas solo por ahora.",
        avecToi = "{1} contigo: {2}",
        pasEnPartie = "no estas en partida.",
        personneNiRdv = "nadie en la partida y ningun punto de encuentro. Que alguien pulse F3 donde querais reuniros.",
        tuArrives = "llegas cerca de {1}.",
        deplacementEchoue = "el desplazamiento ha fallado. Enviame esta linea.",
        pointMarque = "punto marcado para todos.",
        tuFaisSigne = "saludas con la mano.",
        coffreVide = "el cofre comun esta vacio. Desde el lanzador, pestana Cofre, puedes dejar cosas.",
        coffre = "cofre comun: {1}",
        aide = "F1 depuracion - F2 criaturas ({1}) - F3 punto de encuentro - F4 ayuda - F5 unirse - F6 quien esta - F7 instalar el mundo - F9 publicar - F10 cofre - F11 marcar - F12 saludo",
        debugFerme = "depuracion cerrada.",
        rdvPose = "punto de encuentro puesto aqui.",
        demandeInstaller = "peticion enviada al lanzador: instalar el mundo del servidor...",
        demandePublier = "peticion enviada al lanzador: publicar tu partida...",
        debugJoueurs = "jugadores {1}",
        debugCreatures = "criaturas {1} (ocultas {2}, clases {3})",
        debugMode = "modo {1}",
        debugHote = " / anfitrion",
        debugRendu = "render {1}",
        debugEnvoyes = "enviados {1}",
        debugHorloge = "reloj {1}s",
    },
}

--[[ Le texte, dans la langue courante, avec ses valeurs inserees. ]]
local function L(cle, ...)
    local table_ = TEXTES[langue] or TEXTES.fr
    local modele = table_[cle] or TEXTES.fr[cle] or cle
    local valeurs = { ... }
    -- ATTENTION : UNE VALEUR MANQUANTE LAISSE SON MARQUEUR VISIBLE.
    return (modele:gsub("{(%d)}", function(n)
        local v = valeurs[tonumber(n)]
        if v == nil then return "{" .. n .. "}" end
        return tostring(v)
    end))
end

local function ecran(texte, couleur, secondes)
    local propre = ascii(texte)

    local pc = controleur()
    if estValide(pc) then
        local ok = sur(function()
            pc:AddMessageBySlot("Voyage", propre)
            return true
        end, false)
        if ok then
            noterFait("ecran", "AddMessageBySlot")
            return
        end
    end

    local ks = kismet()
    if not estValide(ks) then
        journal(propre)  -- au pire, la console le dira
        return
    end
    local m = monde()
    local ok = sur(function()
        ks:PrintString(m, "[Voyage] " .. propre, true, false, couleur or BLANC, secondes or 6.0)
        return true
    end, false)
    noterFait("ecran", ok and "PrintString" or "aucun")
    if not ok then journal(propre) end
end

-- ═══════════════════════════════════════════════════════════════════════════
--  ENVOI VERS LE PONT
-- ═══════════════════════════════════════════════════════════════════════════

--- Ouvre le tube, ou le fichier de repli.
local function ouvrir()
    local f = io.open(TUBE, "w")
    if f then
        parFichier = false
        pcall(function() f:setvbuf("no") end)
        journal("branche au pont.")
        return f
    end

    -- Repli : un fichier que le pont relit. Moins direct, mais ca marche.
    local g = io.open(dossierTemp() .. "\\voyage-lien.txt", "a")
    if g then
        parFichier = true
        pcall(function() g:setvbuf("no") end)
        journal("pont introuvable : passage par un fichier.")
        return g
    end
    return nil
end

--[[
  Depose une ligne a envoyer au pont.

  ⚠️ ON DEPOSE, ON N'ECRIT PAS. Une ecriture sur un tube nomme BLOQUE tant que
     personne ne lit a l'autre bout. Faite depuis une touche, elle figeait ce
     fil puis faisait tomber le jeu ; faite depuis le fil du jeu, elle figerait
     le jeu ENTIER, puisque c'est lui qui dessine. La ligne est donc mise de
     cote, et le battement — qui ecrit deja dans le tube a son rythme et sait
     quoi faire quand il se coupe — s'en charge au passage suivant.

  ⚠️ LA FILE A UN PLAFOND. Une file qui deborde veut dire que le lien est mort :
     empiler n'y changerait rien, et la memoire monterait sans fin.
]]
local function deposer(ligne)
    if #aEnvoyer < 64 then
        aEnvoyer[#aEnvoyer + 1] = ligne
    end
end

local function demanderAuLanceur(commande)
    if not sortie then
        ecran(L("pasConnecte"), ORANGE, 8.0)
        return false
    end
    deposer("cmd " .. commande)
    return true
end

--- Vide la file. Appelee par le battement, jamais par une touche.
local function envoyerLaFile()
    if not sortie or #aEnvoyer == 0 then return end
    local lot = aEnvoyer
    aEnvoyer = {}
    for _, ligne in ipairs(lot) do
        local ok = pcall(function() sortie:write(ligne .. "\n") end)
        if not ok then
            pcall(function() sortie:close() end)
            sortie = nil
            ecran(L("lienCoupe"), ORANGE, 6.0)
            return
        end
    end
end

-- ═══════════════════════════════════════════════════════════════════════════
--  LE PION DU JOUEUR
-- ═══════════════════════════════════════════════════════════════════════════

--- Le pion du joueur — et RIEN D'AUTRE.
--
-- ⚠️ PAS DE REPLI SUR `FindFirstOf("Character")`. Il rend le PREMIER
--    personnage du monde, qui est un figurant : en vrai il a rendu
--    `BP_NPC_RollerBoi_ProcWalk_Mini_Test_C`, et le serveur a recu la
--    position d'un PNJ du menu comme si c'etait celle du joueur. Un pion
--    qui n'appartient pas au controleur local n'est jamais le bon.
local function trouverPion()
    local pc = controleur()
    if not estValide(pc) then return nil, false end

    -- Le controleur du menu porte « Menu » dans son nom de classe.
    if nomClasse(pc):find("Menu") then return nil, true end

    local p = sur(function() return pc.Pawn end, nil)
    if not estValide(p) then p = sur(function() return pc:K2_GetPawn() end, nil) end
    if not estValide(p) then return nil, false end

    -- Ceinture et bretelles : ni figurant, ni pion de menu.
    local nom = nomClasse(p)
    if nom:find("NPC") or nom:find("Menu") then return nil, nom:find("Menu") ~= nil end

    return p, false
end

--[[
  Le composant de mouvement d'un acteur.

  ⚠️ LE NOM DE LA PROPRIETE N'EST PAS LE NOM DE L'OBJET. La sonde a rendu
     `...BP_FirstPersonCharacter_New_C1.CharMoveComp` : « CharMoveComp » est le
     nom de l'INSTANCE, pas celui de la propriete, qui s'appelle
     `CharacterMovement` sur ACharacter. On essaie les deux, plus l'accesseur,
     parce qu'un seul des trois suffit et qu'on ne sait pas lequel repondra.
]]
local function composantMouvement(acteur)
    local m = sur(function() return acteur.CharacterMovement end, nil)
    if estValide(m) then return m, "CharacterMovement" end
    m = sur(function() return acteur.CharMoveComp end, nil)
    if estValide(m) then return m, "CharMoveComp" end
    m = sur(function() return acteur:GetCharacterMovement() end, nil)
    if estValide(m) then return m, "GetCharacterMovement()" end
    m = sur(function() return acteur.MovementComponent end, nil)
    if estValide(m) then return m, "MovementComponent" end
    m = sur(function() return acteur:GetMovementComponent() end, nil)
    if estValide(m) then return m, "GetMovementComponent()" end
    return nil, nil
end

--- La vie du pion, ou nil. Le serveur accepte « inconnu », jamais « zero par defaut ».
local function lireVie(acteur)
    local v = sur(function() return acteur:GetHealth() end, nil)
    if type(v) == "number" then
        noterFait("vie", "GetHealth()")
        return v
    end
    v = sur(function() return acteur.Health end, nil)
    if type(v) == "number" then
        noterFait("vie", ".Health")
        return v
    end
    noterFait("vie", "introuvable")
    return nil
end

--- Accroupi, en chute, dans l'eau : ce que le composant de mouvement sait dire.
local function lirePosture(acteur)
    local m = composantMouvement(acteur)
    if not m then return nil end
    if sur(function() return m:IsFalling() end, false) then return "chute" end
    if sur(function() return m:IsSwimming() end, false) then return "nage" end
    if sur(function() return acteur.bIsCrouched end, false) then return "accroupi" end
    return nil
end

-- ═══════════════════════════════════════════════════════════════════════════
--  LES NOMS AU-DESSUS DES TETES
-- ═══════════════════════════════════════════════════════════════════════════

--[[
  ⚠️ LA SONDE A CONFIRME QUE `TextRenderComponent` EXISTE DANS CE JEU. C'est la
     seule classe de la liste qui affiche du texte DANS le monde sans demander un
     widget complet — et un widget ne se cree correctement que par
     `UWidgetBlueprintLibrary::Create`, dont on n'a pas confirme la presence ici.

  ⚠️ POSER LE TEXTE A TROIS CHEMINS POSSIBLES, ET ON NE SAIT PAS LEQUEL REPOND.
     `SetText` attend un `FText`, que le Lua d'UE4SS ne construit pas toujours ;
     `.Text` est la propriete directe. On essaie dans l'ordre, on retient celui
     qui marche, et on le note dans les faits.

  ⚠️ IL Y A UN REPLI, ET IL FONCTIONNE VRAIMENT. Si rien ne prend, F6 et le
     pied de l'ecran donnent la liste des joueurs proches avec distance et
     direction. Ce n'est pas un panneau au-dessus de la tete, mais ce n'est pas
     une fonctionnalite absente non plus : on sait qui est ou.
]]

local classeTexte = nil

local function classeDuTexte()
    if classeTexte ~= nil then return classeTexte end
    classeTexte = sur(function() return StaticFindObject("/Script/Engine.TextRenderComponent") end, false)
    return classeTexte
end

--[[
  Le texte a ecrire au-dessus d une tete, selon les reglages.

  ATTENTION : UNE VALEUR INCONNUE NE S AFFICHE PAS, elle ne s affiche pas a
  zero. Un joueur dont le mod n a pas su lire les points de vie afficherait
  « 0 PV » et passerait pour mourant.
]]
local function texteDePlaque(f)
    if not plaques.noms then return "" end
    local bouts = { f.nom or "?" }
    if plaques.distance and f.distance then
        bouts[#bouts + 1] = string.format("%dm", math.floor(f.distance))
    end
    if plaques.ping and f.ping then bouts[#bouts + 1] = f.ping .. "ms" end
    if plaques.vie and f.vie then bouts[#bouts + 1] = math.floor(f.vie) .. "pv" end
    return table.concat(bouts, "  ")
end

--- Pose un texte sur un TextRenderComponent. Rend le chemin qui a marche, ou nil.
local function poserTexte(composant, texte)
    local propre = ascii(texte)
    if sur(function() composant.Text = propre return true end, false) then return ".Text" end
    if sur(function() composant:SetText(propre) return true end, false) then return "SetText" end
    if sur(function() composant:SetText({ propre }) return true end, false) then return "SetText{}" end
    return nil
end

--[[
  Accroche une plaque de nom a un fantome. Rend le composant, ou nil.

  ⚠️ UN COMPOSANT NON ENREGISTRE NE S'AFFICHE PAS. `StaticConstructObject` cree
     l'objet ; c'est `RegisterComponent` qui le fait exister pour le moteur, et
     `K2_AttachToComponent` qui le place dans la hierarchie de l'acteur. Les
     trois sont necessaires, dans cet ordre.
]]
local function accrocherPlaque(acteur, nom)
    local classe = classeDuTexte()
    if not classe then return nil end

    local composant = sur(function() return StaticConstructObject(classe, acteur) end, nil)
    if not estValide(composant) then return nil end

    -- Enregistrer AVANT d'attacher : un composant non enregistre n'a pas de monde.
    pcall(function() composant:RegisterComponent() end)

    local racine = sur(function() return acteur:K2_GetRootComponent() end, nil)
    if estValide(racine) then
        -- 0 = garder la position relative : on posera l'offset nous-memes.
        pcall(function() composant:K2_AttachToComponent(racine, "", 0, 0, 0, false) end)
    end

    pcall(function() composant:K2_SetRelativeLocation({ X = 0.0, Y = 0.0, Z = 110.0 }, false, {}, false) end)
    pcall(function() composant:SetWorldSize(26.0) end)
    pcall(function() composant:SetHorizontalAlignment(1) end)      -- 1 = centre
    pcall(function() composant:SetTextRenderColor({ R = 220, G = 210, B = 180, A = 255 }) end)

    local chemin = poserTexte(composant, nom)
    if not chemin then
        pcall(function() composant:K2_DestroyComponent(acteur) end)
        noterFait("nameplate", "texte refuse")
        return nil
    end

    noterFait("nameplate", "TextRender" .. chemin)
    return composant
end

--[[
  Tourne la plaque vers le joueur.

  ⚠️ SANS CA, LE NOM EST LISIBLE D'UN SEUL COTE. Un `TextRenderComponent` est un
     plan : vu de derriere, le texte est a l'envers. On l'oriente vers nous a
     chaque battement — dix fois par seconde suffit largement pour l'oeil.
]]
local function tournerPlaque(composant, deLa, versIci)
    if not estValide(composant) then return end
    local dx, dy = (versIci.X or 0) - (deLa.x or 0), (versIci.Y or 0) - (deLa.y or 0)
    local yaw = math.deg(math.atan(dy, dx))
    pcall(function()
        composant:K2_SetWorldRotation({ Pitch = 0.0, Yaw = yaw, Roll = 0.0 }, false, {}, false)
    end)
end

-- ═══════════════════════════════════════════════════════════════════════════
--  LES FANTOMES — faire apparaitre les autres
-- ═══════════════════════════════════════════════════════════════════════════

--[[
  ⚠️ ON NE PEUT PAS APPELER `UWorld::SpawnActor` DEPUIS LUA. C'est une
     fonction C++ a patron, invisible a la reflexion d'Unreal. Le seul
     chemin ouvert passe par les deux UFunction de `UGameplayStatics` :
     `BeginDeferredActorSpawnFromClass` puis `FinishSpawningActor`.

  ⚠️ ON FAIT APPARAITRE LA MEME CLASSE QUE LE JOUEUR LOCAL. On ne devine
     donc aucun nom de classe : l'autre joueur ressemble forcement a ce
     que le joueur est lui-meme, et ca survit aux mises a jour du jeu.

  ⚠️ LES FANTOMES N'ONT PAS DE COLLISION. Un pion solide plante au milieu
     du radeau bloquerait le joueur, et deux joueurs au meme endroit se
     repousseraient sans fin.
]]

local function statistiques()
    local h = aides()
    if h then
        local g = sur(function() return h:GetGameplayStatics() end, nil)
        if estValide(g) then return g end
    end
    return sur(function() return StaticFindObject("/Script/Engine.Default__GameplayStatics") end, nil)
end

local function transformation(x, y, z)
    return {
        Rotation = { X = 0.0, Y = 0.0, Z = 0.0, W = 1.0 },
        Translation = { X = x, Y = y, Z = z },
        Scale3D = { X = 1.0, Y = 1.0, Z = 1.0 },
    }
end

--[[
  Fait apparaitre un pion distant. Rend l'acteur, ou nil.

  ⚠️ CHAQUE ETAPE DIT SON NOM QUAND ELLE ECHOUE. Je ne peux pas lancer le
     jeu : sans ca, un « ca marche pas » ne distingue pas un monde
     introuvable d'une signature d'UFunction qui a bouge, et il faut trois
     allers-retours pour l'apprendre. Une seule ligne de console tranche.
]]
local function faireApparaitre(x, y, z, classe)
    local function abandon(etape)
        if not plainteSpawn then
            plainteSpawn = true
            journal("apparition impossible, etape « " .. etape .. " ». Envoie-moi cette ligne.")
            noterFait("apparition", "echec/" .. etape)
        end
        return nil
    end

    local m = monde()
    if not estValide(m) then return abandon("trouver le monde") end

    local gs = statistiques()
    if not estValide(gs) then return abandon("trouver GameplayStatics") end

    local quelle = classe or classeFantome
    if not quelle then return abandon("connaitre la classe du joueur") end

    local t = transformation(x, y, z)
    -- 1 = « apparais toujours », meme si quelque chose occupe la place.
    local acteur = sur(function()
        return gs:BeginDeferredActorSpawnFromClass(m, quelle, t, 1, nil, 0)
    end, nil)
    if not estValide(acteur) then return abandon("BeginDeferredActorSpawnFromClass") end

    sur(function() return gs:FinishSpawningActor(acteur, t, 0) end, nil)
    if not estValide(acteur) then return abandon("FinishSpawningActor") end

    -- Traversable : il ne doit ni bloquer le joueur ni le pousser.
    pcall(function() acteur:SetActorEnableCollision(false) end)
    noterFait("apparition", "ok")
    return acteur
end

--[[
  Fait apparaitre une creature de l hote. Rend l acteur, ou nil.

  ATTENTION : `AutoPossessAI` DOIT ETRE COUPE AVANT `FinishSpawningActor`. Sans
  ca le pion recoit un controleur d intelligence artificielle des qu il existe :
  il se met a nager ou il veut, a chasser et a mordre, pendant qu on le teleporte
  ailleurs dix fois par seconde. Le joueur aurait alors DEUX requins -- le vrai
  fantome et celui qui le poursuit. C est tout l interet de l apparition
  differee : entre `Begin` et `Finish`, l acteur existe mais n a pas encore
  demarre.

  ATTENTION : PAS DE COLLISION, PAS DE DEGATS. Un fantome n est qu une image : il
  ne doit ni bloquer le joueur, ni le blesser, ni pouvoir etre tue -- la vraie
  creature, celle qui compte, vit chez l hote.
]]
local function faireApparaitreCreature(x, y, z, classe)
    local m = monde()
    local gs = statistiques()
    if not estValide(m) or not estValide(gs) or not classe then return nil end

    local t = transformation(x, y, z)
    local acteur = sur(function()
        return gs:BeginDeferredActorSpawnFromClass(m, classe, t, 1, nil, 0)
    end, nil)
    if not estValide(acteur) then
        noterFait("miroir", "apparition refusee")
        return nil
    end

    -- 0 = EAutoPossessAI::Disabled. A poser AVANT que l acteur demarre.
    pcall(function() acteur.AutoPossessAI = 0 end)
    pcall(function() acteur.bCanBeDamaged = false end)

    sur(function() return gs:FinishSpawningActor(acteur, t, 0) end, nil)
    if not estValide(acteur) then return nil end

    pcall(function() acteur:SetActorEnableCollision(false) end)
    -- Ceinture et bretelles : si un controleur s est quand meme attache, on le lache.
    pcall(function() acteur:DetachFromControllerPendingDestroy() end)

    noterFait("miroir", "fantomes de creatures")
    return acteur
end

--[[
  Pose la vitesse sur le composant de mouvement du pion distant.

  ⚠️ C'EST CA QUI ANIME, PAS UNE ANIMATION REPLIQUEE. Le pion distant porte le
     blueprint d'animation du jeu — la sonde l'a confirme : `ABP_Manny_New_C`
     sur `CharacterMesh0`. Ce blueprint choisit marche, course ou repos d'apres
     la vitesse du composant de mouvement. `K2_TeleportTo` pose la position
     sans y toucher, d'ou des joueurs qui glissent immobiles.

  ⚠️ LA SONDE A DIT « .Velocity (ecriture) : POSSIBLE ». C'est la seule raison
     pour laquelle ce chemin est ecrit comme le chemin principal et non comme
     un essai parmi d'autres.
]]
local function animer(acteur, vx, vy, vz)
    local m, par = composantMouvement(acteur)
    if not m then
        noterFait("animation", "composant introuvable")
        return
    end
    local ok = sur(function()
        m.Velocity = { X = vx or 0, Y = vy or 0, Z = vz or 0 }
        return true
    end, false)
    noterFait("animation", ok and ("Velocity via " .. par) or "ecriture refusee")
end

local function deplacer(acteur, x, y, z, yaw)
    -- `K2_TeleportTo` pose position ET orientation d'un coup.
    local ok = pcall(function()
        acteur:K2_TeleportTo({ X = x, Y = y, Z = z }, { Pitch = 0.0, Yaw = yaw, Roll = 0.0 })
    end)
    if ok then return true end
    return pcall(function()
        acteur:K2_SetActorLocation({ X = x, Y = y, Z = z }, false, {}, false)
    end)
end

--[[
  Range une position dans le tampon d'un fantome.

  ⚠️ UN TAMPON BORNE. Huit positions a 10 Hz font 800 ms d'historique : plus
     que necessaire pour couvrir une perte de paquet, et assez peu pour ne
     jamais peser.
]]
local function empiler(f, j)
    f.tampon[#f.tampon + 1] = {
        t = horlogeMs, x = j.x, y = j.y, z = j.z, yaw = j.yaw,
        vx = j.vx, vy = j.vy, vz = j.vz,
    }
    while #f.tampon > 8 do table.remove(f.tampon, 1) end
end

--[[
  Ou afficher un fantome, maintenant.

  ⚠️ ON INTERPOLE ENTRE DEUX POSITIONS DU PASSE, PAS VERS LA DERNIERE RECUE.
     Viser la derniere recue veut dire sauter des qu'un paquet manque. Avec
     150 ms de retard, on a presque toujours deux positions qui encadrent
     l'instant affiche.

  ⚠️ ON EXTRAPOLE, MAIS PAS LONGTEMPS. Quand le serveur se tait, continuer sur
     la vitesse connue garde le mouvement credible une demi-seconde. Au-dela on
     s'arrete : un joueur qui continue de courir tout seul a travers la carte est
     pire qu'un joueur fige.
]]
local function ouAfficher(f, retard)
    local cible = horlogeMs - (retard or RETARD_RENDU_MS)
    local n = #f.tampon
    if n == 0 then return nil end

    -- Deux positions encadrent l'instant vise : on interpole.
    for i = n, 2, -1 do
        local b, a = f.tampon[i], f.tampon[i - 1]
        if a.t <= cible and cible <= b.t then
            local duree = b.t - a.t
            local part = duree > 0 and (cible - a.t) / duree or 1
            return {
                x = a.x + (b.x - a.x) * part,
                y = a.y + (b.y - a.y) * part,
                z = a.z + (b.z - a.z) * part,
                yaw = b.yaw,
                mode = "interpolation",
            }
        end
    end

    local dernier = f.tampon[n]
    local avance = cible - dernier.t

    if avance > 0 then
        if avance > EXTRAPOLATION_MAX_MS then
            return { x = dernier.x, y = dernier.y, z = dernier.z, yaw = dernier.yaw, mode = "arret" }
        end
        local s = avance / 1000
        return {
            x = dernier.x + (dernier.vx or 0) * s,
            y = dernier.y + (dernier.vy or 0) * s,
            z = dernier.z + (dernier.vz or 0) * s,
            yaw = dernier.yaw,
            mode = "extrapolation",
        }
    end

    -- L'instant vise est avant tout ce qu'on a : on prend le plus ancien.
    local premier = f.tampon[1]
    return { x = premier.x, y = premier.y, z = premier.z, yaw = premier.yaw, mode = "attente" }
end

local function oublierTous()
    for id, f in pairs(fantomes) do
        if estValide(f.plaque) then
            pcall(function() f.plaque:K2_DestroyComponent(f.acteur) end)
        end
        if estValide(f.acteur) then pcall(function() f.acteur:K2_DestroyActor() end) end
        fantomes[id] = nil
    end
end

-- ═══════════════════════════════════════════════════════════════════════════
--  LECTURE DE CE QUE LE PONT DEPOSE
-- ═══════════════════════════════════════════════════════════════════════════

--[[
  Lit le fichier depose par le pont.

  ⚠️ LA PREMIERE LIGNE ANNONCE COMBIEN DE JOUEURS SUIVENT. Le pont reecrit ce
     fichier dix fois par seconde ; si on tombe au milieu d'une ecriture, le
     compte ne tombe pas juste et on jette la lecture plutot que de faire
     clignoter un fantome.

  ⚠️ LE NOM EST TOUJOURS LE DERNIER CHAMP. C'est le seul qui peut contenir des
     espaces : tout nouveau champ s'insere AVANT lui, jamais apres. Le marqueur
     de version (`v3`) permet a un mod plus ancien de refuser proprement plutot
     que de lire « 100 Alex » comme un nom.
]]
local function lireDuPont()
    if not fichierAutres then fichierAutres = dossierTemp() .. "\\voyage-autres.txt" end

    local f = io.open(fichierAutres, "r")
    if not f then return nil end
    local contenu = sur(function() return f:read("a") end, nil)
    pcall(function() f:close() end)
    if not contenu or contenu == "" then return nil end

    local attendus, joueurs, vus = nil, {}, 0
    local lot = { creatures = {}, faits = {}, coffre = {} }

    for ligne in contenu:gmatch("[^\r\n]+") do
        local mot = ligne:match("^(%S+)")

        if mot == "v3" or mot == "v2" then
            attendus = tonumber(ligne:match("^v%d+%s+%-?%d+%s+(%d+)"))

        elseif mot == "hote" then
            lot.hote = ligne:match("^hote%s+(%S+)") == "1"

        elseif mot == "mode" then
            -- Le lanceur decide du mode ; le mod l applique.
            lot.mode = ligne:match("^mode%s+(%a+)")

        elseif mot == "plaques" then
            -- plaques <noms> <distance> <ping> <vie> <portee en metres>
            local n, d, p, v, portee = ligne:match(
                "^plaques%s+(%d)%s+(%d)%s+(%d)%s+(%d)%s+(%d+)")
            if n then
                lot.plaques = {
                    noms = n == "1", distance = d == "1", ping = p == "1", vie = v == "1",
                    -- L interface parle en metres, Unreal en centimetres.
                    portee = (tonumber(portee) or 80) * 100,
                }
            end

        elseif mot == "debug" then
            lot.debug = ligne:match("^debug%s+(%d)") == "1"

        elseif mot == "langue" then
            lot.langue = ligne:match("^langue%s+(%a%a)")

        elseif mot == "rdv" then
            local rx, ry, rz, ryaw, rqui = ligne:match("^rdv%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(.*)$")
            if rx and tonumber(rx) then
                rendezVous = {
                    x = tonumber(rx), y = tonumber(ry), z = tonumber(rz),
                    yaw = tonumber(ryaw) or 0, parQui = rqui or "?",
                }
            end

        elseif mot == "t" then
            -- t <heure> <minute> <jour> <cadence> <meteo>
            local h, mi, jour, cadence, meteo = ligne:match(
                "^t%s+(%d+)%s+(%d+)%s+(%d+)%s+(%d+)%s+(.*)$")
            if not h then
                -- Un pont plus ancien n envoyait pas la cadence.
                h, mi, jour, meteo = ligne:match("^t%s+(%d+)%s+(%d+)%s+(%d+)%s+(.*)$")
                cadence = "0"
            end
            if h then
                heureServeur = {
                    heure = tonumber(h), minute = tonumber(mi),
                    jour = tonumber(jour), cadence = tonumber(cadence) or 0,
                    meteo = meteo,
                }
            end

        elseif mot == "n" then
            -- Creature : n <id> <x> <y> <z> <yaw> <vie> <classe>
            local id, x, y, z, yaw, vie, classe = ligne:match(
                "^n%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(.*)$")
            if id and tonumber(x) then
                lot.creatures[id] = {
                    x = tonumber(x), y = tonumber(y), z = tonumber(z),
                    yaw = tonumber(yaw) or 0, vie = tonumber(vie), classe = classe or "?",
                }
            end

        elseif mot == "f" then
            -- Fait ponctuel : f <genre> <x> <y> <z> <texte>
            local genre, x, y, z, reste = ligne:match("^f%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(.*)$")
            if genre then
                lot.faits[#lot.faits + 1] = {
                    genre = genre, x = tonumber(x), y = tonumber(y), z = tonumber(z),
                    texte = reste or "",
                }
            end

        elseif mot == "c" then
            local nombre, nom = ligne:match("^c%s+(%d+)%s+(.*)$")
            if nombre then lot.coffre[#lot.coffre + 1] = { nom = nom, nombre = tonumber(nombre) } end

        elseif mot == "j" then
            --[[
              ATTENTION : ON ESSAIE LE FORMAT LE PLUS RICHE D'ABORD. Le nom reste
              en dernier parce que c'est le seul champ qui peut contenir des
              espaces ; chaque nouveau champ s'insere donc AVANT lui. Lire une
              ligne v3 avec le motif v2 donnerait « vie nom » comme nom.
            ]]
            local id, x, y, z, yaw, vx, vy, vz, vie, nom = ligne:match(
                "^j%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(.*)$")
            if not (id and tonumber(x) and tonumber(vx) and tonumber(vie)) then
                id, x, y, z, yaw, vx, vy, vz, nom = ligne:match(
                    "^j%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(.*)$")
                vie = nil
            end
            if not (id and tonumber(x)) then
                id, x, y, z, yaw, nom = ligne:match("^j%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(.*)$")
                vx, vy, vz = 0, 0, 0
            end
            if id and tonumber(x) then
                --[[
                  ATTENTION : UNE VIE NEGATIVE VEUT DIRE « INCONNUE ». Le pont
                  envoie -1 quand le mod d en face n a pas su lire les points de
                  vie ; la garder telle quelle afficherait tout le monde comme
                  mourant, et un jour une barre de vie a -1.
                ]]
                local vieNombre = tonumber(vie or "")
                if vieNombre and vieNombre < 0 then vieNombre = nil end
                joueurs[id] = {
                    x = tonumber(x), y = tonumber(y), z = tonumber(z),
                    yaw = tonumber(yaw) or 0, nom = nom or id,
                    vx = tonumber(vx) or 0, vy = tonumber(vy) or 0, vz = tonumber(vz) or 0,
                    vie = vieNombre,
                }
                vus = vus + 1
            end
        end
    end

    if attendus == nil or attendus ~= vus then return nil end
    lot.joueurs = joueurs
    return lot
end

--- Le lanceur et le serveur repondent par un fichier ; on le relit sans attendre.
local function lireMessages()
    if not fichierMessages then fichierMessages = dossierTemp() .. "\\voyage-message.txt" end
    local f = io.open(fichierMessages, "r")
    if not f then return end
    local contenu = sur(function() return f:read("a") end, nil)
    pcall(function() f:close() end)
    if not contenu or contenu == "" or contenu == dernierMessageVu then return end
    dernierMessageVu = contenu

    -- Format : « <ton> <texte> », le ton decide de la couleur.
    local ton, texte = contenu:match("^(%a+)%s+(.*)$")
    if not texte then texte = contenu end
    local couleur = BLANC
    if ton == "bon" then couleur = VERT elseif ton == "erreur" then couleur = ORANGE end
    ecran((texte:gsub("%s+$", "")), couleur, 10.0)
end

-- ═══════════════════════════════════════════════════════════════════════════
--  APPLIQUER CE QU'ON A RECU
-- ═══════════════════════════════════════════════════════════════════════════

local function suivreLesAutres(lot)
    local joueurs = lot.joueurs
    if not joueurs then return end

    local pion = trouverPion()
    local maPos = pion and sur(function() return pion:K2_GetActorLocation() end, nil) or nil

    for id, j in pairs(joueurs) do
        local f = fantomes[id]

        --[[
          ⚠️ UN ACTEUR NE SURVIT PAS A UN CHANGEMENT DE CARTE. Il est detruit
             avec le niveau ; sans ce controle on deplacerait un fantome mort
             pour toujours et plus personne n'apparaitrait apres un
             chargement.
        ]]
        if f and not estValide(f.acteur) then
            fantomes[id] = nil
            f = nil
        end

        if not f then
            local acteur = faireApparaitre(j.x, j.y, j.z)
            if acteur then
                f = { acteur = acteur, nom = j.nom, tampon = {}, x = j.x, y = j.y, z = j.z }
                f.plaque = accrocherPlaque(acteur, j.nom)
                fantomes[id] = f
                journal(j.nom .. " apparait.")
                ecran(L("estLa", j.nom), VERT, 5.0)
            end
        else
            empiler(f, j)
            f.nom = j.nom
            f.vie = j.vie

            local ou = ouAfficher(f)
            if ou then
                f.x, f.y, f.z = ou.x, ou.y, ou.z
                deplacer(f.acteur, ou.x, ou.y, ou.z, ou.yaw)
                noterFait("rendu", ou.mode)
            else
                -- Repli : lissage exponentiel, comme avant le tampon.
                f.x = f.x + (j.x - f.x) * LISSAGE
                f.y = f.y + (j.y - f.y) * LISSAGE
                f.z = f.z + (j.z - f.z) * LISSAGE
                deplacer(f.acteur, f.x, f.y, f.z, j.yaw)
            end

            animer(f.acteur, j.vx, j.vy, j.vz)

            --[[
              ATTENTION : LA PLAQUE SE MET A JOUR, ELLE N EST PAS POSEE UNE FOIS.
              La distance change a chaque pas, le ping et la vie aussi. Et
              au-dela de la portee reglee, on la cache plutot que d afficher un
              nom illisible a l autre bout de la carte.
            ]]
            if f.plaque and maPos then
                local dx = (f.x or 0) - (maPos.X or 0)
                local dy = (f.y or 0) - (maPos.Y or 0)
                local dz = (f.z or 0) - (maPos.Z or 0)
                local d = math.sqrt(dx * dx + dy * dy + dz * dz)
                f.distance = d / 100

                local visible = plaques.noms and d <= plaques.portee
                pcall(function() f.plaque:SetVisibility(visible, false) end)
                if visible then
                    poserTexte(f.plaque, texteDePlaque(f))
                    tournerPlaque(f.plaque, f, maPos)
                end
            end
        end
    end

    -- Ceux qui ne sont plus dans la liste ont quitte.
    for id, f in pairs(fantomes) do
        if not joueurs[id] then
            if estValide(f.plaque) then
                pcall(function() f.plaque:K2_DestroyComponent(f.acteur) end)
            end
            if estValide(f.acteur) then pcall(function() f.acteur:K2_DestroyActor() end) end
            local nom = f.nom or id
            fantomes[id] = nil
            journal(nom .. " est parti.")
            ecran(L("estParti", nom), BLANC, 5.0)
        end
    end
end

--[[
  Affiche les faits ponctuels venus du serveur.

  ⚠️ ON NE REJOUE AUCUN SON NI AUCUNE ANIMATION. Le serveur transporte le FAIT,
     pas le contenu : « une alarme a sonne la-bas ». Le jeu de chacun joue ce
     qu'il a deja chez lui — c'est la seule facon de ne rien redistribuer.
]]
local function montrerLesFaits(lot)
    for _, f in ipairs(lot.faits or {}) do
        local couleur = BLANC
        if f.genre == "alarme" or f.genre == "explosion" then couleur = ORANGE end
        if f.genre == "ping" then couleur = OR end
        if f.texte and f.texte ~= "" then ecran(f.texte, couleur, 7.0) end
    end
end

--[[
  Applique l'heure du serveur.

  ⚠️ ON NE L'IMPOSE QUE SI LE JEU L'ACCEPTE, ET JAMAIS AU CHARGEMENT. Ecrire
     dans le ciel pendant que le jeu met sa partie en place peut court-circuiter
     une sequence. On attend d'etre en jeu, et on n'ecrit que toutes les dix
     secondes : repousser la meme valeur dix fois par seconde empecherait le jeu
     de faire avancer son propre temps.
]]
local dernierReglageHeure = 0

local function appliquerHeure()
    if not heureServeur then return end
    --[[
      ATTENTION : A CADENCE ZERO, ON NE TOUCHE PAS AU CIEL DU JOUEUR. Le serveur
      connait toujours une heure -- midi par defaut -- mais connaitre n est pas
      faire autorite. Sans ce test, un serveur dont l hebergeur n a rien demande
      imposerait midi a tout le monde, dix fois par minute, et personne ne
      comprendrait pourquoi la nuit ne tombe jamais. `CYCLE_MINUTES` cote serveur
      est ce qui lui donne le droit d ecrire ici.
    ]]
    if (heureServeur.cadence or 0) <= 0 then
        noterFait("heure", "serveur sans autorite (cadence 0)")
        return
    end
    if horlogeMs - dernierReglageHeure < 10000 then return end
    dernierReglageHeure = horlogeMs

    local ciel = sur(function() return FindFirstOf("Ultra_Dynamic_Sky_Voyage_C") end, nil)
    if not estValide(ciel) then
        ciel = sur(function() return FindFirstOf("Ultra_Dynamic_Sky_C") end, nil)
    end
    if not estValide(ciel) then
        noterFait("heure", "ciel introuvable")
        return
    end

    -- Ultra Dynamic Sky compte l'heure en minutes depuis minuit.
    local minutes = heureServeur.heure * 60 + heureServeur.minute
    local ok = sur(function() ciel.TimeOfDay = minutes return true end, false)
    if not ok then
        ok = sur(function() ciel:SetTimeOfDay(minutes) return true end, false)
    end
    noterFait("heure", ok and "posee sur le ciel" or "ecriture refusee")
end

-- ═══════════════════════════════════════════════════════════════════════════
--  LES CREATURES — recensement par l'hote
-- ═══════════════════════════════════════════════════════════════════════════

--[[
  ⚠️ LE JEU FAIT APPARAITRE SES CREATURES CHEZ CHACUN, SEPAREMENT. Rien ne
     relie le requin de l'un a celui de l'autre : ce ne sont pas les memes
     acteurs. On ne peut donc pas les « synchroniser » ; ce qu'on peut faire,
     c'est que l'hote dise ce qu'il voit, et que les autres l'affichent.

  ⚠️ ON NE PARCOURT PAS 7 862 ACTEURS DIX FOIS PAR SECONDE. Le monde charge en
     contient autant — la sonde l'a compte. On balaye `Pawn` et `Character`
     (quelques dizaines) toutes les dix secondes, on retient ce qui ressemble a
     une creature, et ensuite on ne suit que cette petite table.
]]

local MOTIFS_CREATURE = { "^BP_NPC_", "^BP_Swarm", "NPCBaseCharacter$", "^BP_Creature" }

local function estCreature(nom)
    for _, motif in ipairs(MOTIFS_CREATURE) do
        if nom:find(motif) then return true end
    end
    return false
end

--[[
  Masque une creature locale, et retient comment la rendre.

  ATTENTION : TROIS GESTES, ET LES TROIS SONT NECESSAIRES. Cacher ne suffit pas
  (elle mord toujours), couper la collision ne suffit pas (elle nage et declenche
  des sons), couper le tick ne suffit pas (elle reste visible, figee en plein
  milieu). Les trois ensemble donnent une creature qui n existe plus pour le
  joueur -- sans etre detruite, donc sans casser le generateur qui la suit.
]]
local function masquerCreatureLocale(cle, acteur)
    if masquees[cle] then return end
    local ok = sur(function()
        acteur:SetActorHiddenInGame(true)
        return true
    end, false)
    pcall(function() acteur:SetActorEnableCollision(false) end)
    pcall(function() acteur:SetActorTickEnabled(false) end)
    if ok then
        masquees[cle] = acteur
        noterFait("miroir", "creatures locales masquees")
    else
        noterFait("miroir", "masquage refuse")
    end
end

--- Rend toutes les creatures locales qu on avait masquees.
local function rendreLesCreaturesLocales()
    local combien = 0
    for cle, acteur in pairs(masquees) do
        if estValide(acteur) then
            pcall(function() acteur:SetActorHiddenInGame(false) end)
            pcall(function() acteur:SetActorEnableCollision(true) end)
            pcall(function() acteur:SetActorTickEnabled(true) end)
            combien = combien + 1
        end
        masquees[cle] = nil
    end
    if combien > 0 then journal(combien .. " creature(s) locale(s) rendue(s).") end
end

--- Detruit tous les fantomes de creatures.
local function oublierLesCreaturesDistantes()
    for id, f in pairs(fantomesCreatures) do
        if estValide(f.acteur) then pcall(function() f.acteur:K2_DestroyActor() end) end
        fantomesCreatures[id] = nil
    end
end

--[[
  Retient la classe d une creature locale.

  ATTENTION : SANS ELLE, LE MIROIR NE PEUT RIEN AFFICHER. On ne connait aucun
  chemin d asset, et les deviner casserait a la premiere mise a jour du jeu. La
  classe se prend sur une creature que le jeu du joueur a fait apparaitre lui-meme.
]]
local function retenirClasse(acteur)
    local nom = nomClasse(acteur)
    if nom == "?" or classesCreatures[nom] then return end
    local classe = sur(function() return acteur:GetClass() end, nil)
    if classe then
        classesCreatures[nom] = classe
        noterFait("miroir.classes", tostring(nom))
    end
end

local function balayerLesCreatures()
    local trouvees = 0
    for _, famille in ipairs({ "VoyageNPCBaseCharacter", "Pawn", "Character" }) do
        local liste = sur(function() return FindAllOf(famille) end, nil)
        if liste then
            for i = 1, #liste do
                local a = liste[i]
                if estValide(a) then
                    local n = nomClasse(a)
                    if estCreature(n) then
                        local cle = sur(function() return a:GetFName():ToString() end, nil)
                        if cle and not creatures[cle] then
                            creatures[cle] = { acteur = a, classe = n }
                            trouvees = trouvees + 1
                        end
                        --[[
                          Chez un NON-hote en mode miroir, la creature locale sert
                          deux fois : elle donne sa classe (c est la seule facon
                          d en faire apparaitre une), puis elle est masquee.
                        ]]
                        if cle and not jeSuisHote and modeCreatures == "miroir" then
                            retenirClasse(a)
                            masquerCreatureLocale(cle, a)
                        end
                    end
                end
            end
        end
        -- La classe de base du jeu suffit si elle existe : pas besoin des autres.
        if famille == "VoyageNPCBaseCharacter" and trouvees > 0 then break end
    end
    if trouvees > 0 then noterFait("creatures", tostring(trouvees) .. " reperees") end
    return trouvees
end

--[[
  Applique ce que l hote voit.

  ATTENTION : LE MOD NE DECIDE PAS DE CE QUI EXISTE, IL AFFICHE. La liste vient
  du serveur, qui n ecoute que l hote. Un fantome dont l identifiant disparait de
  la liste est detruit : c est ainsi qu une creature morte chez l hote disparait
  chez les autres.
]]
local function suivreLesCreatures(lot)
    if jeSuisHote or modeCreatures ~= "miroir" then return end
    local recues = lot.creatures or {}

    for id, c in pairs(recues) do
        local f = fantomesCreatures[id]

        -- Un acteur ne survit pas a un changement de carte.
        if f and not estValide(f.acteur) then
            fantomesCreatures[id] = nil
            f = nil
        end

        if not f then
            local classe = classesCreatures[c.classe]
            if classe then
                local acteur = faireApparaitreCreature(c.x, c.y, c.z, classe)
                if acteur then
                    fantomesCreatures[id] = {
                        acteur = acteur, classe = c.classe, tampon = {},
                        x = c.x, y = c.y, z = c.z,
                    }
                end
            else
                --[[
                  On n a jamais vu cette classe localement : impossible d en faire
                  apparaitre une. On le DIT plutot que de laisser un trou -- c est
                  exactement le genre d absence qu on cherche a ne pas livrer en
                  silence.
                ]]
                noterFait("miroir.manque", tostring(c.classe))
            end
        else
            empiler(f, { x = c.x, y = c.y, z = c.z, yaw = c.yaw, vx = 0, vy = 0, vz = 0 })
            local ou = ouAfficher(f, RETARD_CREATURES_MS)
            if ou then
                --[[
                  La vitesse est DEDUITE du deplacement, pas transmise : l hote ne
                  lit pas la velocite des creatures. Sans elle, le blueprint
                  d animation les croit immobiles et le requin glisse sans nager.
                ]]
                local dx, dy, dz = ou.x - f.x, ou.y - f.y, ou.z - f.z
                local parSeconde = 1000.0 / PERIODE_MS
                f.x, f.y, f.z = ou.x, ou.y, ou.z
                deplacer(f.acteur, ou.x, ou.y, ou.z, ou.yaw)
                animer(f.acteur, dx * parSeconde, dy * parSeconde, dz * parSeconde)
            end
        end
    end

    -- Ce qui n est plus dans la liste n existe plus chez l hote.
    for id, f in pairs(fantomesCreatures) do
        if not recues[id] then
            if estValide(f.acteur) then pcall(function() f.acteur:K2_DestroyActor() end) end
            fantomesCreatures[id] = nil
        end
    end
end

--[[
  Change de mode, et defait proprement ce que l ancien avait fait.

  ATTENTION : QUITTER LE MIROIR DOIT TOUT RENDRE. Un joueur qui coupe le miroir
  parce que quelque chose cloche ne doit pas se retrouver dans un ocean vide, avec
  ses propres requins masques pour toujours.
]]
local function changerDeMode(nouveau)
    if nouveau == modeCreatures then return end
    modeCreatures = nouveau
    oublierLesCreaturesDistantes()
    if nouveau ~= "miroir" then rendreLesCreaturesLocales() end
    -- Le prochain battement rebalaye : les creatures locales seront reprises.
    dernierBalayage = 0
    journal("creatures : mode " .. nouveau .. ".")
    ecran(L("creatures", nouveau), BLANC, 5.0)
end

--[[
  Envoie au serveur ce que l'hote voit.

  ⚠️ SEUL L'HOTE ENVOIE. Si chacun declarait ses creatures, le registre en
     contiendrait quatre pour une — et le serveur les refuserait de toute facon.

  ⚠️ LE LOT EST BORNE. Le serveur n'accepte pas plus de 64 creatures par
     paquet ; en envoyer plus serait du travail jete.
]]
local function recenserPourLeServeur()
    if not jeSuisHote or not sortie then return end

    local combien = 0
    local morts = {}
    for cle, c in pairs(creatures) do
        if not estValide(c.acteur) then
            morts[#morts + 1] = cle
        elseif combien < 60 then
            local p = sur(function() return c.acteur:K2_GetActorLocation() end, nil)
            if p then
                local r = sur(function() return c.acteur:K2_GetActorRotation() end, nil)
                local vie = sur(function() return c.acteur:GetHealth() end, nil)
                if type(vie) ~= "number" then vie = sur(function() return c.acteur.Health end, -1) end
                deposer(string.format(
                    "pnj %s %.1f %.1f %.1f %.1f %s %s",
                    cle, p.X or 0, p.Y or 0, p.Z or 0,
                    r and r.Yaw or 0, tostring(vie or -1), c.classe))
                combien = combien + 1
            end
        end
    end

    -- Une creature detruite chez l'hote doit disparaitre chez les autres.
    for _, cle in ipairs(morts) do
        creatures[cle] = nil
        deposer("pnjmort " .. cle)
    end

    if combien > 0 then deposer("pnjfin " .. combien) end
end

-- ═══════════════════════════════════════════════════════════════════════════
--  INVENTAIRE
-- ═══════════════════════════════════════════════════════════════════════════

--[[
  ⚠️ ON NE CONNAIT PAS ENCORE L'API DU COMPOSANT D'INVENTAIRE DE CE JEU, ET ON
     NE LA DEVINE PAS. La sonde a confirme que `GetInventoryComponent` existe
     sur le pion ET sur le controleur, mais pas ce que le composant expose.
     Appeler une UFunction avec le mauvais nombre d'arguments passe par-dessus la
     pile d'Unreal et fait tomber le jeu.

  ⚠️ CE QU'ON FAIT A LA PLACE : on essaie, dans l'ordre, les noms que les jeux
     Unreal emploient d'habitude, chacun sous `pcall`, et on NOTE celui qui a
     repondu. Le fait part au serveur, `/sonde` l'affiche, et la sonde complete
     remonte la liste exacte des fonctions du composant. Tant que rien ne
     repond, l'inventaire est declare « illisible » — jamais « vide ».
]]

local function composantInventaire()
    local pion = trouverPion()
    if estValide(pion) then
        local c = sur(function() return pion:GetInventoryComponent() end, nil)
        if estValide(c) then return c, "pion" end
    end
    local pc = controleur()
    if estValide(pc) then
        local c = sur(function() return pc:GetInventoryComponent() end, nil)
        if estValide(c) then return c, "controleur" end
    end
    return nil, nil
end

--- Les objets portes, sous la forme { {nom, nombre} }, ou nil si illisible.
local function lireInventaire()
    local comp, ou = composantInventaire()
    if not comp then
        noterFait("inventaire", "composant introuvable")
        return nil
    end

    local candidats = { "GetItems", "GetAllItems", "GetInventoryItems", "GetSlots", "GetInventorySlots" }
    local liste, par = nil, nil

    for _, nomF in ipairs(candidats) do
        local r = sur(function() return comp[nomF](comp) end, nil)
        if r and sur(function() return #r end, 0) > 0 then
            liste, par = r, nomF .. "()"
            break
        end
    end

    if not liste then
        for _, nomP in ipairs({ "Items", "Slots", "InventorySlots", "Content" }) do
            local r = sur(function() return comp[nomP] end, nil)
            if r and sur(function() return #r end, 0) > 0 then
                liste, par = r, "." .. nomP
                break
            end
        end
    end

    if not liste then
        noterFait("inventaire", "composant " .. ou .. ", contenu illisible")
        return nil
    end

    local objets, combien = {}, sur(function() return #liste end, 0)
    for i = 1, math.min(combien, 60) do
        local entree = liste[i]
        if entree ~= nil then
            -- Une entree peut etre l'objet, ou l'emplacement qui le contient.
            local nom = sur(function() return entree.ItemName end, nil)
                or sur(function() return entree.Name end, nil)
                or sur(function() return entree:GetItemName() end, nil)
            local nombre = sur(function() return entree.Amount end, nil)
                or sur(function() return entree.Quantity end, nil)
                or sur(function() return entree.Count end, nil)
                or 1
            if nom ~= nil then
                local texte = tostring(nom)
                if texte ~= "" and texte ~= "None" then
                    objets[#objets + 1] = { nom = texte, nombre = tonumber(nombre) or 1 }
                end
            end
        end
    end

    noterFait("inventaire", par .. " / " .. tostring(#objets) .. " objets")
    if #objets == 0 then return nil end
    return objets
end

local function declarerInventaire()
    if not sortie then return end
    local objets = lireInventaire()
    if not objets then return end
    for _, o in ipairs(objets) do
        deposer(string.format("inv %d %s", o.nombre, o.nom))
    end
    deposer("invfin " .. #objets)
end

-- ═══════════════════════════════════════════════════════════════════════════
--  CROCHETS SUR LE JEU
-- ═══════════════════════════════════════════════════════════════════════════

--[[
  ⚠️ `RegisterHook` A DES LIMITES QU'IL FAUT CONNAITRE AVANT D'ECRIRE UNE
     LIGNE :
       — sur un objet blueprint, seules les fonctions DEFINIES en blueprint
         s'accrochent ;
       — le rappel arrive AVANT pour une fonction native, APRES pour une
         fonction blueprint ;
       — les delegues ne s'accrochent pas ;
       — une fonction a la fois `Final` et `BlueprintCallable` ne s'accroche
         pas ;
       — la UFunction doit DEJA etre en memoire : on ne peut donc pas poser les
         crochets au chargement du mod, il faut attendre qu'un monde soit
         charge.

  ⚠️ LES NOMS VIENNENT DE LA SONDE, PAS D'UNE SUPPOSITION. Chacune des
     fonctions ci-dessous apparait dans le rapport reel du jeu. Celles qui ne
     s'accrochent pas le disent dans les faits — on ne pretend pas les avoir.
]]

local crochetsPoses = false

local function poserLesCrochets()
    if crochetsPoses then return end
    crochetsPoses = true

    --- Pose un crochet, et note s'il a pris.
    local function accrocher(chemin, etiquette, rappel)
        local ok = pcall(function()
            RegisterHook(chemin, function(...)
                -- Un crochet qui plante ne doit pas faire tomber le jeu.
                pcall(rappel, ...)
            end)
        end)
        noterFait("crochet." .. etiquette, ok and "pose" or "refuse")
        return ok
    end

    --- La position du joueur, ou des zeros : un crochet ne doit jamais echouer la-dessus.
    local function maPosition()
        local pion = trouverPion()
        local p = pion and sur(function() return pion:K2_GetActorLocation() end, nil) or nil
        return p and (p.X or 0) or 0, p and (p.Y or 0) or 0, p and (p.Z or 0) or 0
    end

    -- Interaction : le joueur actionne quelque chose.
    accrocher("/Script/Voyage.VoyagePlayerController:OnPlayerInteraction", "interaction", function()
        local x, y, z = maPosition()
        deposer(string.format("ev interrupteur %.1f %.1f %.1f interaction", x, y, z))
    end)

    -- Mort : c'est l'information que les autres doivent avoir tout de suite.
    accrocher("/Script/Voyage.VoyageBaseCharacter:OnSurvivalDeath", "mort", function()
        local x, y, z = maPosition()
        deposer(string.format("ev mort %.1f %.1f %.1f mort", x, y, z))
    end)

    -- Degats : utile pour savoir qu'un ami se fait attaquer.
    accrocher("/Script/Voyage.VoyageBaseCharacter:OnVisualizeDamage", "degat", function()
        local x, y, z = maPosition()
        deposer(string.format("ev degat %.1f %.1f %.1f degat", x, y, z))
    end)

    --[[
      Inventaire : quelque chose est entre dans le sac.

      ⚠️ ON NE LIT PAS L'INVENTAIRE DANS LE CROCHET. Le jeu n'a peut-etre pas
         fini sa mise a jour quand le rappel arrive, et un parcours de listes
         dans un crochet est exactement le genre de chose qui fait tomber le
         jeu. On remet simplement le compteur a zero : le battement suivant
         declarera.
    ]]
    accrocher("/Script/Voyage.VoyageBaseCharacter:OnInventoryAdd", "inventaire", function()
        dernierInventaire = 0
    end)

    -- Construction : le joueur pose une piece.
    accrocher("/Script/Voyage.BP_FirstPersonCharacter_New_C:Place", "construction", function()
        local x, y, z = maPosition()
        deposer(string.format("ev pose %.1f %.1f %.1f construction", x, y, z))
    end)

    --[[
      ⚠️ `NotifyOnNewObject` TIENT COMPTE DE L'HERITAGE, ET C'EST POUR CA QU'IL
         EST ICI PLUTOT QU'UN BALAYAGE. Une creature qui apparait est signalee a
         l'instant meme, sans parcourir le monde — ce qu'on ne peut pas se
         permettre a 7 862 acteurs.
    ]]
    for _, classe in ipairs({ "VoyageNPCBaseCharacter", "Character" }) do
        local ok = pcall(function()
            NotifyOnNewObject("/Script/Voyage." .. classe, function(objet)
                pcall(function()
                    local n = nomClasse(objet)
                    if not estCreature(n) then return end
                    local cle = sur(function() return objet:GetFName():ToString() end, nil)
                    if not cle then return end
                    creatures[cle] = { acteur = objet, classe = n }
                    --[[
                      ATTENTION : LE JEU CONTINUE D EN FAIRE APPARAITRE CHEZ LE
                      NON-HOTE. Les masquer seulement au balayage, toutes les dix
                      secondes, laisserait un requin bien reel nager dix secondes
                      au milieu des fantomes. Ici on le prend a la seconde ou il
                      nait -- et on retient sa classe au passage, parce que c est
                      la seule source possible.
                    ]]
                    if not jeSuisHote and modeCreatures == "miroir" then
                        retenirClasse(objet)
                        masquerCreatureLocale(cle, objet)
                    end
                end)
            end)
        end)
        if ok then
            noterFait("creatures.notify", classe)
            break
        end
    end
end

-- ═══════════════════════════════════════════════════════════════════════════
--  LE MENU EN JEU
-- ═══════════════════════════════════════════════════════════════════════════

--[[
  ⚠️ ON NE PEUT PAS DESSINER UNE FENETRE DEPUIS LE LUA D'UE4SS. Pas d'ImGui,
     pas de widget construit a la main sans un travail demesure. Ce qui marche
     vraiment, et qui suffit : le systeme de messages du jeu, et a defaut
     `PrintString`.

  ⚠️ LE MOD NE FAIT RIEN LUI-MEME DE CE QUI TOUCHE AUX FICHIERS. Installer un
     monde depuis le jeu, c'est ecraser des sauvegardes pendant qu'une partie
     tourne. Le mod ENVOIE une demande au lanceur par le tube ; le lanceur
     decide, sauvegarde d'abord, et repond. Le jeu ne touche jamais au disque.
]]

local CARDINAUX = { "nord", "nord-est", "est", "sud-est", "sud", "sud-ouest", "ouest", "nord-ouest" }

--[[
  Le cap d'un fantome par rapport a moi.

  ⚠️ DANS UNREAL, X VA VERS LE NORD ET Y VERS L'EST. Inverser les deux donne un
     cap qui a l'air plausible et qui est faux de 90 degres — le genre d'erreur
     qu'on ne voit qu'en jeu, en marchant dans la mauvaise direction.
]]
local function direction(de, vers)
    local angle = math.deg(math.atan((vers.y or 0) - (de.Y or 0), (vers.x or 0) - (de.X or 0)))
    if angle < 0 then angle = angle + 360 end
    return CARDINAUX[(math.floor(angle / 45 + 0.5) % 8) + 1]
end

local function montrerLesAutres()
    local pion = trouverPion()
    local maPos = pion and sur(function() return pion:K2_GetActorLocation() end, nil) or nil

    local lignes = {}
    for _, f in pairs(fantomes) do
        if maPos then
            local dx, dy, dz = (f.x or 0) - (maPos.X or 0), (f.y or 0) - (maPos.Y or 0), (f.z or 0) - (maPos.Z or 0)
            local d = math.sqrt(dx * dx + dy * dy + dz * dz) / 100
            lignes[#lignes + 1] = string.format("%s %dm %s", f.nom or "?", math.floor(d), direction(maPos, f))
        else
            lignes[#lignes + 1] = f.nom or "?"
        end
    end

    if #lignes == 0 then
        ecran(L("seul"), BLANC, 6.0)
    else
        ecran(L("avecToi", #lignes, table.concat(lignes, " - ")), VERT, 8.0)
    end
end

--[[
  ⚠️ ON NE TELEPORTE JAMAIS QUELQU'UN TOUT SEUL. Le serveur est heberge : il
     n'a aucun joueur de reference, donc chacun charge SA sauvegarde et
     atterrit ou bon lui semble. Il faut donc un point de retrouvailles —
     mais deplacer quelqu'un a son arrivee, c'est le sortir de sa partie
     sans lui demander, et si le point vient d'un AUTRE monde c'est le jeter
     dans le vide. On propose, il appuie.

  ⚠️ ON ARRIVE A COTE, ET UN PEU AU-DESSUS. Atterrir exactement sur les
     coordonnees d'un autre joueur, c'est apparaitre DANS lui, ou dans le
     sol qu'il occupe. Un pas de cote et une petite hauteur : on tombe sur
     ce sur quoi il se tient, au lieu de s'y encastrer.
]]
local ECART = 250.0
local HAUTEUR = 120.0

local function leplusProche(pos)
    local meilleur, meilleureDistance = nil, nil
    for _, f in pairs(fantomes) do
        local dx, dy, dz = (f.x or 0) - pos.X, (f.y or 0) - pos.Y, (f.z or 0) - pos.Z
        local d = dx * dx + dy * dy + dz * dz
        if not meilleureDistance or d < meilleureDistance then
            meilleur, meilleureDistance = f, d
        end
    end
    return meilleur
end

local function seRapprocher()
    local pion = trouverPion()
    if not estValide(pion) then
        ecran(L("pasEnPartie"), ORANGE, 5.0)
        return
    end

    local pos = sur(function() return pion:K2_GetActorLocation() end, nil)
    if not pos then return end

    local cible, quoi = nil, nil
    local proche = leplusProche(pos)
    if proche then
        cible = { x = proche.x, y = proche.y, z = proche.z }
        quoi = proche.nom or "un autre joueur"
    elseif rendezVous then
        cible = { x = rendezVous.x, y = rendezVous.y, z = rendezVous.z }
        quoi = "le point de rendez-vous (" .. (rendezVous.parQui or "?") .. ")"
    end

    if not cible then
        ecran(L("personneNiRdv"), ORANGE, 12.0)
        return
    end

    local ok = pcall(function()
        pion:K2_TeleportTo(
            { X = cible.x + ECART, Y = cible.y, Z = cible.z + HAUTEUR },
            { Pitch = 0.0, Yaw = 0.0, Roll = 0.0 }
        )
    end)
    if ok then
        ecran(L("tuArrives", quoi), VERT, 6.0)
    else
        ecran(L("deplacementEchoue"), ORANGE, 8.0)
    end
end

--- Pose un point que tout le monde verra.
local function poserUnPing()
    local pion = trouverPion()
    if not estValide(pion) then
        ecran(L("pasEnPartie"), ORANGE, 5.0)
        return
    end
    local p = sur(function() return pion:K2_GetActorLocation() end, nil)
    if not p then return end
    deposer(string.format("ev ping %.1f %.1f %.1f ici", p.X or 0, p.Y or 0, p.Z or 0))
    ecran(L("pointMarque"), OR, 5.0)
end

local function saluer()
    deposer("cmd geste-salut")
    ecran(L("tuFaisSigne"), BLANC, 4.0)
end

local function montrerLeCoffre()
    if #coffreServeur == 0 then
        ecran(L("coffreVide"), BLANC, 9.0)
        return
    end
    local bouts = {}
    for i = 1, math.min(#coffreServeur, 8) do
        bouts[#bouts + 1] = coffreServeur[i].nom .. " x" .. coffreServeur[i].nombre
    end
    ecran(L("coffre", table.concat(bouts, ", ")), OR, 10.0)
end

--[[
  Ce que le mode debug affiche.

  ATTENTION : CE SONT DES CHIFFRES REELS, PAS UNE DECORATION. Nombre de
  fantomes, mode de rendu du dernier calcul, creatures suivies, classes
  retenues : c est exactement ce qu il faut savoir quand quelque chose ne
  s affiche pas, et c est introuvable autrement.
]]
--[[
  Applique les reglages venus du lanceur.

  ATTENTION : LIRE ET APPLIQUER SONT DEUX GESTES, et il faut les separer.
  Melanges, ils rendent le reglage intestable : un banc d essai qui lit le
  fichier ne declenche rien, et on croit que la lecture est cassee alors que
  c est l application qui n a jamais eu lieu. C est exactement ce que l essai
  a attrape.
]]
local function appliquerReglages(lot)
    if lot.plaques then plaques = lot.plaques end
    if lot.debug ~= nil then debug = lot.debug end
    if lot.langue and TEXTES[lot.langue] then langue = lot.langue end
end

local function montrerDebug()
    local nFantomes, nCreatures, nMasquees, nClasses = 0, 0, 0, 0
    for _ in pairs(fantomes) do nFantomes = nFantomes + 1 end
    for _ in pairs(fantomesCreatures) do nCreatures = nCreatures + 1 end
    for _ in pairs(masquees) do nMasquees = nMasquees + 1 end
    for _ in pairs(classesCreatures) do nClasses = nClasses + 1 end

    local lignes = {
        L("debugJoueurs", nFantomes),
        L("debugCreatures", nCreatures, nMasquees, nClasses),
        L("debugMode", modeCreatures) .. (jeSuisHote and L("debugHote") or ""),
        L("debugRendu", faits["rendu"] or "?"),
        L("debugEnvoyes", envoyes),
        L("debugHorloge", math.floor(horlogeMs / 1000)),
    }
    ecran(table.concat(lignes, " | "), OR, 12.0)

    for cle, valeur in pairs(faits) do
        journal("debug " .. cle .. " = " .. valeur)
    end
end

local function montrerAide()
    ecran(L("aide", modeCreatures), BLANC, 16.0)
end

--[[
  ⚠️ LES TOUCHES SONT DES TOUCHES DE FONCTION, PAS DES LETTRES. Le jeu se
     joue au clavier : prendre « M » ou « I » volerait une commande de jeu.
     F8 reste a la sonde de diagnostic.
]]
local function poserLesTouches()
    --[[
      ⚠️ `RegisterKeyBind` SE DECLENCHE SUR UN FIL QUI N'EST PAS CELUI DU JEU.
         Toucher un objet Unreal depuis ce fil fait tomber le jeu — pas tout de
         suite, pas a tous les coups : la premiere fois passe souvent, la
         suivante plante. C'est exactement ce qui arrivait avec F5 (poser le
         rendez-vous, s'y rendre, recommencer).

      ⚠️ `pcall` NE SUFFIT PAS. Il attrape une erreur Lua, pas un plantage natif
         venu d'un acces depuis le mauvais fil. Il faut repasser le travail au
         fil du jeu avec `ExecuteInGameThread`, et garder le `pcall` a
         l'interieur pour les erreurs ordinaires.
    ]]
    local function lier(touche, action)
        pcall(function()
            RegisterKeyBind(Key[touche], function()
                ExecuteInGameThread(function() pcall(action) end)
            end)
        end)
    end

    --[[
      ATTENTION : F2 EST UN INTERRUPTEUR DE SECOURS, PAS UN REGLAGE DE CONFORT. Le
      miroir masque les creatures du joueur et en fait apparaitre d autres : si
      quelque chose tourne mal en pleine partie, il doit pouvoir tout rendre sans
      quitter le jeu ni chercher dans le lanceur.
    ]]
    lier("F1", function()
        debug = not debug
        if debug then montrerDebug() else ecran(L("debugFerme"), BLANC, 4.0) end
    end)
    lier("F2", function()
        changerDeMode(modeCreatures == "miroir" and "annonce" or "miroir")
    end)
    lier("F3", function()
        ecran(L("rdvPose"), VERT, 6.0)
        demanderAuLanceur("rdv-poser")
    end)
    lier("F4", montrerAide)
    lier("F5", seRapprocher)
    lier("F6", montrerLesAutres)
    lier("F7", function()
        ecran(L("demandeInstaller"), BLANC, 6.0)
        demanderAuLanceur("installer-monde")
    end)
    lier("F9", function()
        ecran(L("demandePublier"), BLANC, 6.0)
        demanderAuLanceur("publier-monde")
    end)
    lier("F10", montrerLeCoffre)
    lier("F11", poserUnPing)
    lier("F12", saluer)
end

-- ═══════════════════════════════════════════════════════════════════════════
--  BATTEMENT
-- ═══════════════════════════════════════════════════════════════════════════

local function envoyerLesFaits()
    local bouts = {}
    for cle, valeur in pairs(faits) do
        bouts[#bouts + 1] = cle .. "=" .. valeur
    end
    table.sort(bouts)
    local texte = table.concat(bouts, ";")
    if texte == faitsEnvoyes or texte == "" then return end
    faitsEnvoyes = texte
    deposer("faits " .. texte)
end

local function battement()
    horlogeMs = horlogeMs + PERIODE_MS
    local pion, auMenu = trouverPion()

    if auMenu or not estValide(pion) then
        -- Au menu les fantomes n'ont plus de monde ou vivre.
        if next(fantomes) ~= nil then oublierTous() end
        if next(fantomesCreatures) ~= nil then oublierLesCreaturesDistantes() end
        --[[
          ATTENTION : LES CREATURES MASQUEES APPARTENAIENT A L ANCIEN MONDE. Garder
          la table apres un retour au menu ferait croire au miroir qu il les a deja
          masquees, et les vraies creatures de la partie suivante resteraient
          visibles a cote des fantomes.
        ]]
        masquees = {}
        creatures = {}
        annoncer(auMenu and "au menu — rien a envoyer tant qu'une partie n'est pas chargee."
                        or "chargement…")
        return ExecuteWithDelay(ATTENTE_MS, function() pcall(battement) end)
    end

    -- La classe des autres joueurs, c'est la notre.
    if classeFantome == nil then
        classeFantome = sur(function() return pion:GetClass() end, nil)
        if classeFantome then journal("les autres joueurs auront l'allure de " .. nomClasse(pion) .. ".") end
    end

    -- Les crochets ne peuvent se poser qu'une fois un monde charge.
    pcall(poserLesCrochets)

    if not sortie then sortie = ouvrir() end

    if not sortie then
        if os.time() - derniereAlerte > 15 then
            derniereAlerte = os.time()
            journal("pont pas encore la — dans le lanceur, bouton « Connecter ».")
        end
        return ExecuteWithDelay(ATTENTE_MS, function() pcall(battement) end)
    end

    local pos = sur(function() return pion:K2_GetActorLocation() end, nil)
    local rot = sur(function() return pion:K2_GetActorRotation() end, nil)
    if pos then
        annoncer("en partie : " .. nomClasse(pion) .. " — envoi en cours.")
        -- La vitesse fait marcher les jambes des autres : leur pion lit la
        -- velocite pour choisir son animation.
        local vit = sur(function() return pion:GetVelocity() end, nil)
        local vie = lireVie(pion)
        local posture = lirePosture(pion)
        local ligne = string.format(
            "pos %.2f %.2f %.2f %.2f %.2f %.2f %.1f %.1f %.1f %s %s",
            pos.X or 0, pos.Y or 0, pos.Z or 0,
            rot and rot.Pitch or 0, rot and rot.Yaw or 0, rot and rot.Roll or 0,
            vit and vit.X or 0, vit and vit.Y or 0, vit and vit.Z or 0,
            vie and string.format("%.0f", vie) or "-",
            posture or "-"
        )
        local ok = pcall(function() sortie:write(ligne .. "\n") end)
        if ok then
            envoyes = envoyes + 1
            if envoyes % 300 == 0 then
                journal(envoyes .. " positions envoyees" .. (parFichier and " (par fichier)" or ""))
            end
        else
            --[[
              Le pont s'est ferme : on rouvrira au prochain passage.

              ATTENTION : ON REND LES CREATURES LOCALES. Sans ca, un joueur qui perd
              la connexion se retrouve dans un ocean vide -- les siennes masquees,
              celles de l hote plus mises a jour -- et croit le jeu casse.
            ]]
            pcall(function() sortie:close() end)
            sortie = nil
            dernierEtat = ""
            oublierTous()
            oublierLesCreaturesDistantes()
            rendreLesCreaturesLocales()
        end
    end

    --[[
      Le recensement et l inventaire sont rares.

      ATTENTION : LE BALAYAGE SERT AUX DEUX COTES. Chez l hote il trouve les
      creatures a rapporter ; chez les autres, en mode miroir, il trouve celles a
      masquer et donne leurs classes. Le reserver a l hote -- ce qu il faisait --
      laissait le miroir sans aucune classe a faire apparaitre.
    ]]
    local maintenant = os.time()
    local besoinDeBalayer = jeSuisHote or modeCreatures == "miroir"
    if besoinDeBalayer and maintenant - dernierBalayage >= BALAYAGE_S then
        dernierBalayage = maintenant
        pcall(balayerLesCreatures)
    end
    -- En millisecondes : `os.time()` ne descend pas sous la seconde, et les
    -- creatures sautaient d un bond entre deux rapports.
    if jeSuisHote and horlogeMs - dernierRecensement >= RECENSEMENT_MS then
        dernierRecensement = horlogeMs
        pcall(recenserPourLeServeur)
    end
    if maintenant - dernierInventaire >= INVENTAIRE_S then
        dernierInventaire = maintenant
        pcall(declarerInventaire)
    end

    pcall(envoyerLesFaits)
    pcall(envoyerLaFile)

    -- Le debug se rafraichit toutes les cinq secondes tant qu il est allume.
    if debug and horlogeMs % 5000 < PERIODE_MS then pcall(montrerDebug) end

    local lot = sur(lireDuPont, nil)
    if lot then
        if lot.hote ~= nil and lot.hote ~= jeSuisHote then
            jeSuisHote = lot.hote
            journal(jeSuisHote and "tu es l'hote : tes creatures seront partagees."
                                or "tu n'es plus l'hote.")
            --[[
              ATTENTION : DEVENIR HOTE DOIT TOUT RENDRE. L hote voit les VRAIES
              creatures -- les siennes. S il gardait ses fantomes et ses creatures
              masquees, il rapporterait au serveur un ocean vide tout en voyant des
              images qui ne sont a personne.
            ]]
            if jeSuisHote then
                oublierLesCreaturesDistantes()
                rendreLesCreaturesLocales()
            end
            dernierBalayage = 0
        end

        -- Le lanceur decide du mode ; on ne le change qu a la demande.
        if lot.mode and lot.mode ~= modeCreatures then
            pcall(function() changerDeMode(lot.mode) end)
        end

        pcall(function() appliquerReglages(lot) end)
        if lot.coffre and #lot.coffre > 0 then coffreServeur = lot.coffre end
        pcall(function() suivreLesAutres(lot) end)
        pcall(function() suivreLesCreatures(lot) end)
        pcall(function() montrerLesFaits(lot) end)
        pcall(appliquerHeure)
    end

    pcall(lireMessages)

    ExecuteWithDelay(PERIODE_MS, function() pcall(battement) end)
end

ExecuteWithDelay(5000, function() pcall(battement) end)
ExecuteWithDelay(6000, function() pcall(poserLesTouches) end)

journal("charge. F4 en jeu pour l'aide. Il enverra ta position des qu'une partie sera ouverte.")

--[[
  Couture d'essai. Le chargeur d'UE4SS ne definit jamais `VOYAGE_ESSAI` :
  en jeu cette ligne ne fait rien. Hors du jeu elle laisse un essai
  appeler l'analyseur REEL plutot qu'une copie qui derivera.
]]
if VOYAGE_ESSAI then
    --[[
      Des accesseurs, pas les valeurs : `rendezVous` et `horlogeMs` sont des
      locaux qui changent APRES le chargement. Rendre la variable ne donnerait
      que son etat initial — nil, zero — et l'essai croirait a une panne.
    ]]
    return {
        lireDuPont = lireDuPont,
        trouverPion = trouverPion,
        pointDeRendezVous = function() return rendezVous end,
        heureDuServeur = function() return heureServeur end,
        modeCreatures = function() return modeCreatures end,
        plaques = function() return plaques end,
        appliquerReglages = appliquerReglages,
        debug = function() return debug end,
        texteDePlaque = texteDePlaque,
        estCreature = estCreature,
        ouAfficher = ouAfficher,
        empiler = empiler,
        horloge = function() return horlogeMs end,
        avancerHorloge = function(ms) horlogeMs = horlogeMs + ms end,
        faits = function() return faits end,
        direction = direction,
        L = L,
        TEXTES = TEXTES,
    }
end
