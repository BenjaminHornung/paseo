# Bestehende Paseo-Gestaltung

Modus: Operate. Host-Settings-Komponenten, theme.colors, adaptive Menüs,
klare Abschnittsüberschriften, ruhige Karten mit Zeilentrennern.
Desktop: zentraler Einstellungsbereich. Kompakt: eine Spalte, keine horizontalen
Formularüberläufe. Drei Bereiche: Rollen & Modelle, Decisions, Keys & Budgets.

Gespeichert/ungespeichert/fehlender Key/Budget gesperrt sind echte Zustände.
Ein allgemeines Speichern hält Entwürfe bei Fehlern und erkennt Revisionkonflikte.
Secret-Eingaben werden nach erfolgreichem Speichern geleert, nie vorausgefüllt.
Farbe allein trägt keine Statusinformation. Text nimmt immer Host-Farbwerte.

Orchestrator-Status: natives Explorer-Panel rechts, vom Host in der Breite
gesteuert. Composer-Pill und Command Center öffnen dasselbe Panel. Kopf mit
Status, Zeitpunkt, Aktualisierung und Auto-Routing bleibt sichtbar. Aktuelle
Aufgabe und echte Phasen darunter; Checks, Decisions/Routing, weitere Aufgaben
und Ereignisse sind aufklappbar. Aufklappzustände werden pro Panel gespeichert.
Fortschrittsanteile zählen ausschließlich COMPLETE; unvollständige Historie
zeigt keinen Nenner. Turnende und Prozessruhe ersetzen keine Verifikation.

Screenshotkorrektur: kompakte 28px-Aktionen statt großer SettingsAction-Zeilen;
Disclosures mit 7px vertikalem Padding. Ziel/Abnahme, Hauptchat, Worker, Modell,
Routing-Kurzgrund, Build, Tests, Diff und Review bleiben offen sichtbar.
Native Lucide-Icons statt Unicode-Symbole. Der öffentliche Live-Workerzustand
und die letzte Aktivität ergänzen den Controllerzustand. Eine Abgleichwarnung
gilt nur bei RUNNING/SENDING und länger ruhendem Worker, nicht bei erwarteter
Prozessruhe. Workspace-Panels lösen den eindeutigen aktiven Hauptchat auf;
mehrere Hauptchats erhalten eine explizite Auswahl statt versteckter Controls.
