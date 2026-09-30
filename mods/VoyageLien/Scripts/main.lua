--[[
═══════════════════════════════════════════════════════════════════════════
  VOYAGE — LIEN AVEC LE SERVEUR
═══════════════════════════════════════════════════════════════════════════
  Deux sens :
    ENVOI      la position du joueur part vers le pont, qui fait le reseau.
    RECEPTION  les positions des autres reviennent, et on fait apparaitre
               un pion par joueur distant.

  ⚠️ LE LUA D'UE4SS N'A PAS DE SOCKETS. Il ne peut ni ouvrir une connexion
     UDP ni en lire une. Il sait par contre ouvrir un FICHIER — et sous
     Windows un tube nomme s'ouvre comme un fichier. On ecrit donc dans
     le tube, et `pont.js` fait le reseau.

  ⚠️ ON NE LIT PAS LE TUBE, ON LIT UN FICHIER. `f:read()` sur un tube BLOQUE
     tant que rien n'arrive — et ce blocage a lieu dans le fil de jeu : le
     jeu se fige. Le pont depose donc les autres joueurs dans un fichier
     qu'on relit sans jamais attendre.

  ⚠️ TOUT EST EN pcall. Une erreur Lua dans un mod UE4SS peut figer le jeu.
═══════════════════════════════════════════════════════════════════════════
]]

local NOM = "VoyageLien"
local TUBE = "\\\\.\\pipe\\voyage-lien"
local PERIODE_MS = 100          -- 10 envois par seconde
local ATTENTE_MS = 2000         -- au menu, ou sans pont : on regarde moins souvent
local LISSAGE = 0.35            -- 0 = fige, 1 = saute d'un coup

local sortie = nil
local parFichier = false
local envoyes = 0
local derniereAlerte = 0
local dernierEtat = ""

--- Les pions distants, par identifiant de joueur.
local fantomes = {}
local classeFantome = nil
local fichierAutres = nil
local rendezVous = nil
local plainteSpawn = false

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
    local sortie = tostring(texte)
    for de, vers in pairs(REMPLACEMENTS) do
        sortie = sortie:gsub(de, vers)
    end
    -- Ce qui reste hors ASCII devient un point : illisible vaut mieux que faux.
    sortie = sortie:gsub("[\128-\255]", ".")
    return sortie
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

-- ═══════════════════════════════════════════════════════════════════════════
--  ENVOI
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

--- Le pion du joueur — et RIEN D'AUTRE.
--
-- ⚠️ PAS DE REPLI SUR `FindFirstOf("Character")`. Il rend le PREMIER
--    personnage du monde, qui est un figurant : en vrai il a rendu
--    `BP_NPC_RollerBoi_ProcWalk_Mini_Test_C`, et le serveur a recu la
--    position d'un PNJ du menu comme si c'etait celle du joueur. Un pion
--    qui n'appartient pas au controleur local n'est jamais le bon.
local function trouverPion()
    local pc = sur(function() return FindFirstOf("PlayerController") end, nil)
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

-- ═══════════════════════════════════════════════════════════════════════════
--  RECEPTION — faire apparaitre les autres
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
local function faireApparaitre(x, y, z)
    local function abandon(etape)
        if not plainteSpawn then
            plainteSpawn = true
            journal("apparition impossible, etape « " .. etape .. " ». Envoie-moi cette ligne.")
        end
        return nil
    end

    local m = monde()
    if not estValide(m) then return abandon("trouver le monde") end

    local gs = statistiques()
    if not estValide(gs) then return abandon("trouver GameplayStatics") end

    if not classeFantome then return abandon("connaitre la classe du joueur") end

    local t = transformation(x, y, z)
    -- 1 = « apparais toujours », meme si quelque chose occupe la place.
    local acteur = sur(function()
        return gs:BeginDeferredActorSpawnFromClass(m, classeFantome, t, 1, nil, 0)
    end, nil)
    if not estValide(acteur) then return abandon("BeginDeferredActorSpawnFromClass") end

    sur(function() return gs:FinishSpawningActor(acteur, t, 0) end, nil)
    if not estValide(acteur) then return abandon("FinishSpawningActor") end

    -- Traversable : il ne doit ni bloquer le joueur ni le pousser.
    pcall(function() acteur:SetActorEnableCollision(false) end)
    return acteur
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

--- Lit le fichier depose par le pont. Rend une table [id] = {x,y,z,yaw,nom}.
--
-- ⚠️ LA PREMIERE LIGNE ANNONCE COMBIEN DE JOUEURS SUIVENT. Le pont reecrit
--    ce fichier dix fois par seconde ; si on tombe au milieu d'une
--    ecriture, le compte ne tombe pas juste et on jette la lecture plutot
--    que de faire clignoter un fantome.
local function lireAutres()
    if not fichierAutres then fichierAutres = dossierTemp() .. "\\voyage-autres.txt" end

    local f = io.open(fichierAutres, "r")
    if not f then return nil end
    local contenu = sur(function() return f:read("a") end, nil)
    pcall(function() f:close() end)
    if not contenu or contenu == "" then return nil end

    local attendus, joueurs, vus = nil, {}, 0
    for ligne in contenu:gmatch("[^\r\n]+") do
        local n = ligne:match("^v1%s+%d+%s+(%d+)")
        local rx, ry, rz, ryaw, rqui = ligne:match("^rdv%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(.*)$")
        if n then
            attendus = tonumber(n)
        elseif rx and tonumber(rx) then
            -- Le point de rendez-vous voyage dans le meme fichier que les joueurs.
            rendezVous = {
                x = tonumber(rx), y = tonumber(ry), z = tonumber(rz),
                yaw = tonumber(ryaw) or 0, parQui = rqui or "?",
            }
        else
            local id, x, y, z, yaw, nom = ligne:match("^j%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(%S+)%s+(.*)$")
            if id and tonumber(x) then
                joueurs[id] = {
                    x = tonumber(x), y = tonumber(y), z = tonumber(z),
                    yaw = tonumber(yaw) or 0, nom = nom or id,
                }
                vus = vus + 1
            end
        end
    end

    if attendus == nil or attendus ~= vus then return nil end
    return joueurs
end

local function oublierTous()
    for id, f in pairs(fantomes) do
        if estValide(f.acteur) then pcall(function() f.acteur:K2_DestroyActor() end) end
        fantomes[id] = nil
    end
end

local function suivreLesAutres()
    local joueurs = lireAutres()
    if not joueurs then return end

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
                fantomes[id] = { acteur = acteur, x = j.x, y = j.y, z = j.z, nom = j.nom }
                journal(j.nom .. " apparait.")
                ecran(j.nom .. " est la.", VERT, 5.0)
            end
        else
            -- Lissage : sans lui, 10 positions par seconde donnent des saccades.
            f.x = f.x + (j.x - f.x) * LISSAGE
            f.y = f.y + (j.y - f.y) * LISSAGE
            f.z = f.z + (j.z - f.z) * LISSAGE
            f.nom = j.nom
            deplacer(f.acteur, f.x, f.y, f.z, j.yaw)
        end
    end

    -- Ceux qui ne sont plus dans la liste ont quitte.
    for id, f in pairs(fantomes) do
        if not joueurs[id] then
            if estValide(f.acteur) then pcall(function() f.acteur:K2_DestroyActor() end) end
            journal((f.nom or id) .. " est parti.")
            ecran((f.nom or id) .. " est parti.", BLANC, 5.0)
            fantomes[id] = nil
        end
    end
end


-- ═══════════════════════════════════════════════════════════════════════════
--  LE MENU EN JEU
-- ═══════════════════════════════════════════════════════════════════════════

--[[
  ⚠️ ON NE PEUT PAS DESSINER UNE FENETRE DEPUIS LE LUA D'UE4SS. Pas d'ImGui,
     pas de widget construit a la main sans un travail demesure. Ce qui
     marche vraiment, et qui suffit : `PrintString`, une UFunction reflechie
     de `KismetSystemLibrary`, qui ecrit dans un coin de l'ecran.

  ⚠️ LE MOD NE FAIT RIEN LUI-MEME DE CE QUI TOUCHE AUX FICHIERS. Installer un
     monde depuis le jeu, c'est ecraser des sauvegardes pendant qu'une partie
     tourne. Le mod ENVOIE une demande au lanceur par le tube ; le lanceur
     decide, sauvegarde d'abord, et repond. Le jeu ne touche jamais au disque.
]]

local BLANC = { R = 0.85, G = 0.87, B = 0.83, A = 1.0 }
local ORANGE = { R = 0.82, G = 0.35, B = 0.20, A = 1.0 }
local VERT = { R = 0.07, G = 0.70, B = 0.33, A = 1.0 }

local fichierMessages = nil
local dernierMessageVu = ""

local function kismet()
    return sur(function() return StaticFindObject("/Script/Engine.Default__KismetSystemLibrary") end, nil)
end

--- Ecrit une ligne dans le coin de l'ecran.
local function ecran(texte, couleur, secondes)
    local ks = kismet()
    if not estValide(ks) then
        journal(texte)  -- au pire, la console le dira
        return
    end
    local m = monde()
    pcall(function()
        ks:PrintString(m, "[Voyage] " .. ascii(texte), true, false, couleur or BLANC, secondes or 6.0)
    end)
end

--- Demande quelque chose au lanceur, par le tube.
local function demanderAuLanceur(commande)
    if not sortie then
        ecran("pas connecte : ouvre le lanceur et clique « Connecter ».", ORANGE, 8.0)
        return false
    end
    local ok = pcall(function() sortie:write("cmd " .. commande .. "\n") end)
    if not ok then
        pcall(function() sortie:close() end)
        sortie = nil
        ecran("le lien s'est coupe.", ORANGE, 6.0)
        return false
    end
    return true
end

--- Le lanceur repond par un fichier ; on le relit comme celui des autres.
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

--- Qui est en partie avec moi.
local function montrerLesAutres()
    local n = 0
    local noms = {}
    for _, f in pairs(fantomes) do
        n = n + 1
        noms[#noms + 1] = f.nom or "?"
    end
    if n == 0 then
        ecran("tu es seul pour l'instant.", BLANC, 6.0)
    else
        ecran(n .. " avec toi : " .. table.concat(noms, ", "), VERT, 8.0)
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

--- Le joueur distant le plus proche, s'il y en a un.
local function leplusProche(pos)
    local meilleur, meilleureDistance = nil, nil
    for _, f in pairs(fantomes) do
        local dx, dy, dz = f.x - pos.X, f.y - pos.Y, f.z - pos.Z
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
        ecran("pas en partie.", ORANGE, 5.0)
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
        ecran("personne en jeu et aucun point de rendez-vous. Que quelqu'un appuie sur F3 la ou vous voulez vous retrouver.", ORANGE, 12.0)
        return
    end

    local ok = pcall(function()
        pion:K2_TeleportTo(
            { X = cible.x + ECART, Y = cible.y, Z = cible.z + HAUTEUR },
            { Pitch = 0.0, Yaw = 0.0, Roll = 0.0 }
        )
    end)
    if ok then
        ecran("tu arrives pres de " .. quoi .. ".", VERT, 6.0)
    else
        ecran("le deplacement a echoue. Envoie-moi cette ligne.", ORANGE, 8.0)
    end
end

local function montrerAide()
    ecran("F6 qui est la · F7 installer le monde du serveur · F9 publier le tien", BLANC, 10.0)
end

--[[
  ⚠️ LES TOUCHES SONT DES TOUCHES DE FONCTION, PAS DES LETTRES. Le jeu se
     joue au clavier : prendre « M » ou « I » volerait une commande de jeu.
     F8 reste a la sonde de diagnostic.
]]
local function poserLesTouches()
    local function lier(touche, action)
        pcall(function()
            RegisterKeyBind(Key[touche], function() pcall(action) end)
        end)
    end
    lier("F5", seRapprocher)
    lier("F3", function()
        ecran("point de retrouvailles pose ici.", VERT, 6.0)
        demanderAuLanceur("rdv-poser")
    end)
    lier("F6", montrerLesAutres)
    lier("F7", function()
        ecran("demande envoyee au lanceur : installer le monde du serveur…", BLANC, 6.0)
        demanderAuLanceur("installer-monde")
    end)
    lier("F9", function()
        ecran("demande envoyee au lanceur : publier ta partie…", BLANC, 6.0)
        demanderAuLanceur("publier-monde")
    end)
    lier("F4", montrerAide)
end

-- ═══════════════════════════════════════════════════════════════════════════
--  BATTEMENT
-- ═══════════════════════════════════════════════════════════════════════════

local function battement()
    local pion, auMenu = trouverPion()

    if auMenu or not estValide(pion) then
        -- Au menu les fantomes n'ont plus de monde ou vivre.
        if next(fantomes) ~= nil then oublierTous() end
        annoncer(auMenu and "au menu — rien a envoyer tant qu'une partie n'est pas chargee."
                        or "chargement…")
        return ExecuteWithDelay(ATTENTE_MS, function() pcall(battement) end)
    end

    -- La classe des autres joueurs, c'est la notre.
    if classeFantome == nil then
        classeFantome = sur(function() return pion:GetClass() end, nil)
        if classeFantome then journal("les autres joueurs auront l'allure de " .. nomClasse(pion) .. ".") end
    end

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
        local ligne = string.format(
            "pos %.2f %.2f %.2f %.2f %.2f %.2f\n",
            pos.X or 0, pos.Y or 0, pos.Z or 0,
            rot and rot.Pitch or 0, rot and rot.Yaw or 0, rot and rot.Roll or 0
        )
        local ok = pcall(function() sortie:write(ligne) end)
        if ok then
            envoyes = envoyes + 1
            if envoyes % 300 == 0 then
                journal(envoyes .. " positions envoyees" .. (parFichier and " (par fichier)" or ""))
            end
        else
            -- Le pont s'est ferme : on rouvrira au prochain passage.
            pcall(function() sortie:close() end)
            sortie = nil
            dernierEtat = ""
            oublierTous()
        end
    end

    pcall(suivreLesAutres)
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
      Un accesseur, pas la valeur : `rendezVous` est un local qui change
      APRES le chargement. Rendre la variable ne donnerait que son etat
      initial — nil — et l'essai croirait a une panne.
    ]]
    return {
        lireAutres = lireAutres,
        trouverPion = trouverPion,
        pointDeRendezVous = function() return rendezVous end,
    }
end
