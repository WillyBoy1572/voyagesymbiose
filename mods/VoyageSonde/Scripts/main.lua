--[[
═══════════════════════════════════════════════════════════════════════════
  VOYAGE — SONDE DE RECONNAISSANCE
═══════════════════════════════════════════════════════════════════════════
  A poser dans :  <Jeu>\Binaries\Win64\ue4ss\Mods\VoyageSonde\Scripts\main.lua

  Elle ne modifie RIEN dans le jeu et ne connecte personne : elle regarde,
  elle note, et elle ecrit `VoyageSonde.txt` a cote de l'executable.

  ⚠️ ELLE NE DEPEND PLUS D'UNE TOUCHE. La premiere version attendait F8 ; si
     le raccourci n'arrive jamais — fenetre pas focalisee, touche deja prise,
     mod charge avant le jeu — le joueur croit que rien ne marche. Elle
     reessaie donc toute seule jusqu'a trouver le pion, puis s'arrete.

  ⚠️ PAS DE DUMP COMPLET. « Dump Objects » d'UE4SS crache des centaines de Mo
     dont 99 % sont du moteur Unreal standard.

  ⚠️ TOUT EST EN pcall. Une erreur Lua dans un mod UE4SS peut figer le jeu au
     chargement ; ici le pire est une ligne « echec » dans le rapport.
═══════════════════════════════════════════════════════════════════════════
]]

local NOM = "VoyageSonde"
local ESSAIS_MAX = 40        -- 40 x 15 s = 10 minutes de patience
local INTERVALLE_MS = 15000

local essais = 0
local fini = false
local lignes = {}

local function noter(texte)
    lignes[#lignes + 1] = texte
    print("[" .. NOM .. "] " .. texte .. "\n")
end

--- Appelle une fonction en attrapant tout, et rend une valeur de repli.
local function sur(f, repli)
    local ok, r = pcall(f)
    if ok and r ~= nil then return r end
    return repli
end

local function estValide(o)
    return o ~= nil and sur(function() return o:IsValid() end, false)
end

local function nomComplet(objet)
    if not estValide(objet) then return "(invalide)" end
    return sur(function() return objet:GetFullName() end, "(sans nom)")
end

--- La chaine d'heritage : c'est elle qui dit quoi accrocher.
local function hierarchie(objet)
    local sortie, classe, garde = {}, sur(function() return objet:GetClass() end, nil), 0
    while estValide(classe) and garde < 12 do
        sortie[#sortie + 1] = sur(function() return classe:GetFName():ToString() end, "?")
        classe = sur(function() return classe:GetSuperStruct() end, nil)
        garde = garde + 1
    end
    return table.concat(sortie, " < ")
end

local function vecteur(v)
    if not v then return "(rien)" end
    return string.format("X=%.1f  Y=%.1f  Z=%.1f", v.X or 0, v.Y or 0, v.Z or 0)
end

local function ecrireRapport()
    local f = io.open("VoyageSonde.txt", "w")
    if not f then
        print("[" .. NOM .. "] impossible d'ecrire VoyageSonde.txt\n")
        return
    end
    f:write(table.concat(lignes, "\n") .. "\n")
    f:close()
    print("[" .. NOM .. "] rapport ecrit : VoyageSonde.txt\n")
end

--- Cherche le pion du joueur par trois chemins differents.
local function trouverPion()
    local pc = sur(function() return FindFirstOf("PlayerController") end, nil)
    if estValide(pc) then
        local p = sur(function() return pc.Pawn end, nil)
        if estValide(p) then return p, pc end
        p = sur(function() return pc:K2_GetPawn() end, nil)
        if estValide(p) then return p, pc end
    end
    local c = sur(function() return FindFirstOf("Character") end, nil)
    if estValide(c) then return c, pc end
    return nil, pc
end

local function sonder()
    if fini then return end
    essais = essais + 1

    local pion, pc = trouverPion()
    if not estValide(pion) then
        if essais == 1 then
            print("[" .. NOM .. "] en attente d'une partie chargee...\n")
        end
        if essais < ESSAIS_MAX then
            ExecuteWithDelay(INTERVALLE_MS, function() pcall(sonder) end)
        else
            print("[" .. NOM .. "] abandon : aucun pion trouve apres " .. essais .. " essais.\n")
        end
        return
    end

    fini = true
    lignes = {}
    noter("=== SONDE VOYAGE ===")
    noter("date : " .. os.date("%Y-%m-%d %H:%M:%S") .. "   (essai no " .. essais .. ")")

    noter("World : " .. nomComplet(sur(function() return FindFirstOf("World") end, nil)))
    noter("PlayerController : " .. nomComplet(pc))
    if estValide(pc) then noter("  heritage : " .. hierarchie(pc)) end

    noter("Pion du joueur : " .. nomComplet(pion))
    noter("  heritage : " .. hierarchie(pion))
    noter("  position : " .. vecteur(sur(function() return pion:K2_GetActorLocation() end, nil)))
    noter("  rotation : " .. vecteur(sur(function() return pion:K2_GetActorRotation() end, nil)))

    -- Les classes propres au jeu, pas celles du moteur.
    noter("")
    noter("--- Classes « Voyage » reperees ---")
    local vues, compte = {}, 0
    for _, a in ipairs(sur(function() return FindAllOf("Actor") end, {}) or {}) do
        if compte >= 40 then break end
        local n = sur(function() return a:GetClass():GetFName():ToString() end, nil)
        if n and n:find("Voyage") and not vues[n] then
            vues[n] = true
            compte = compte + 1
            noter("  " .. n)
        end
    end
    if compte == 0 then noter("  (aucune)") end

    --[[
      ⚠️ CE BLOC EST LA RECONNAISSANCE QUI MANQUE POUR LE BOUTON « CHARGER »
         DANS LE JEU. Tant qu'on ne connait pas le nom exact des UFunction
         de sauvegarde du jeu, la seule facon de charger un monde reste de
         repasser par SON menu. On ne devine pas ces noms : on les lit.

      ⚠️ ON PARCOURT `Children`, PAS UN DUMP D'OBJETS. Le « Dump Objects »
         d'UE4SS fait des centaines de Mo dont 99 % de moteur standard.
    ]]
    noter("")
    noter("--- Fonctions de sauvegarde / chargement ---")
    local interessant = { "save", "load", "world", "session", "travel", "quit", "continue", "newgame" }
    local vuesF, compteF = {}, 0

    local function fouiller(objet, etiquette)
        if not estValide(objet) then return end
        local classe = sur(function() return objet:GetClass() end, nil)
        while estValide(classe) and compteF < 120 do
            local nomClasse = sur(function() return classe:GetFName():ToString() end, "?")
            -- On s'arrete aux classes du moteur : elles n'ont rien de propre au jeu.
            if nomClasse == "Object" or nomClasse == "Actor" then break end

            local enfant = sur(function() return classe.Children end, nil)
            while estValide(enfant) and compteF < 120 do
                local nf = sur(function() return enfant:GetFName():ToString() end, nil)
                if nf then
                    local bas = nf:lower()
                    for _, mot in ipairs(interessant) do
                        local cle = nomClasse .. ":" .. nf
                        if bas:find(mot) and not vuesF[cle] then
                            vuesF[cle] = true
                            compteF = compteF + 1
                            noter("  " .. etiquette .. " " .. nomClasse .. " : " .. nf)
                            break
                        end
                    end
                end
                enfant = sur(function() return enfant.Next end, nil)
            end

            classe = sur(function() return classe.SuperStruct end, nil)
        end
    end

    fouiller(pc, "[controleur]")
    fouiller(pion, "[pion]")
    fouiller(sur(function() return FindFirstOf("GameModeBase") end, nil), "[mode]")
    fouiller(sur(function() return FindFirstOf("GameInstance") end, nil), "[instance]")
    fouiller(sur(function() return FindFirstOf("GameStateBase") end, nil), "[etat]")
    fouiller(sur(function() return StaticFindObject("/Script/Engine.Default__GameplayStatics") end, nil), "[statics]")

    if compteF == 0 then noter("  (aucune reperee)") end

    --[[
      ⚠️ CONNAITRE LE NOM D'UNE FONCTION NE SUFFIT PAS POUR L'APPELER. Il
         faut ses parametres, dans l'ordre, avec leur type : un appel avec
         le mauvais nombre d'arguments passe par-dessus la pile d'Unreal et
         fait tomber le jeu. On les lit plutot que de les deviner.

      ⚠️ ON NE DEMANDE QUE CE DONT ON A BESOIN. Dumper la signature de tout
         le moteur donnerait des megaoctets illisibles.
    ]]
    noter("")
    noter("--- Signatures qui nous interessent ---")

    local voulues = {
        "TravelToWorldWithSaveGame",
        "TravelToWorldWithGameProgess",
        "InitFreshNewGameProgress",
        "LoadGameFromSlot",
        "SaveGameToSlot",
        "DoesSaveGameExist",
        "CreateSaveGameObject",
    }

    --- Les parametres d'une UFunction, dans l'ordre declare.
    local function signature(fonction)
        local bouts = {}
        local champ = sur(function() return fonction.ChildProperties end, nil)
        local garde = 0
        while estValide(champ) and garde < 24 do
            garde = garde + 1
            local nomP = sur(function() return champ:GetFName():ToString() end, "?")
            local typeP = sur(function() return champ:GetClass():GetFName():ToString() end, "?")
            bouts[#bouts + 1] = nomP .. " : " .. typeP
            champ = sur(function() return champ.Next end, nil)
        end
        if #bouts == 0 then return "(aucun parametre visible)" end
        return table.concat(bouts, ", ")
    end

    local function chercherDans(objet, etiquette)
        if not estValide(objet) then return end
        local classe = sur(function() return objet:GetClass() end, nil)
        local profondeur = 0
        while estValide(classe) and profondeur < 12 do
            profondeur = profondeur + 1
            local nomClasse = sur(function() return classe:GetFName():ToString() end, "?")
            local enfant = sur(function() return classe.Children end, nil)
            local garde = 0
            while estValide(enfant) and garde < 400 do
                garde = garde + 1
                local nf = sur(function() return enfant:GetFName():ToString() end, nil)
                if nf then
                    for _, voulue in ipairs(voulues) do
                        if nf == voulue then
                            noter("  " .. etiquette .. " " .. nomClasse .. " : " .. nf)
                            noter("      " .. signature(enfant))
                        end
                    end
                end
                enfant = sur(function() return enfant.Next end, nil)
            end
            classe = sur(function() return classe.SuperStruct end, nil)
        end
    end

    chercherDans(sur(function() return FindFirstOf("GameInstance") end, nil), "[instance]")
    chercherDans(sur(function() return StaticFindObject("/Script/Engine.Default__GameplayStatics") end, nil), "[statics]")

    -- Le nom exact de l'instance de jeu : c'est sur elle qu'on appellera.
    local gi = sur(function() return FindFirstOf("GameInstance") end, nil)
    noter("")
    noter("instance de jeu : " .. nomComplet(gi))

    -- Ou le jeu range ses sauvegardes, vu de l'interieur.
    noter("")
    noter("--- Sauvegardes ---")
    local ldd = os.getenv("LOCALAPPDATA")
    noter("dossier attendu : " .. (ldd and (ldd .. "\\Voyage\\Saved\\SaveGames") or "(LOCALAPPDATA inconnu)"))

    noter("")
    noter("--- Points d'accroche connus ---")
    local porte = sur(function() return StaticFindObject("/Script/Voyage.VoyageDoorActor") end, nil)
    noter("VoyageDoorActor : " .. (estValide(porte) and "PRESENT" or "absent"))

    noter("")
    noter("=== FIN ===")
    ecrireRapport()
end

-- Premier essai 10 s apres le chargement, puis toutes les 15 s.
ExecuteWithDelay(10000, function() pcall(sonder) end)

-- F8 reste disponible pour forcer, mais plus rien n'en depend.
pcall(function()
    RegisterKeyBind(Key.F8, function()
        fini = false
        essais = 0
        pcall(sonder)
    end)
end)

print("[" .. NOM .. "] chargee. Elle cherchera toute seule des qu'une partie sera ouverte.\n")
