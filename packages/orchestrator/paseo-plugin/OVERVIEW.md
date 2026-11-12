# Orchestrator

Routing, Modelle, Reasoning, Decisions und Budgets des lokalen Controllers direkt
in Paseo einstellen. **Strg+K → Orchestrator-Einstellungen → Enter** öffnet die
Seite; alternativ den Sidebar-Eintrag **Orchestrator** verwenden.

Rollen & Modelle enthält die Primärroute und Fallbacks jeder Rolle. Decisions
enthält Rollenzuordnung, Mindestkonfidenz und Freigaben. Keys & Budgets verwaltet
getrennte Zugangsdaten und USD-Limits. Gespeicherte Einstellungen gelten für neue
Workflows; laufende Aufträge behalten ihre geprüfte Konfiguration.

Der normale Pi-Key wird weiterverwendet. Neue Schlüssel werden auf dem lokalen
Windows-Host mit DPAPI für den aktuellen Benutzer verschlüsselt gespeichert;
die Oberfläche erhält nur ihren Status zurück. Decisions sendet für freigegebene
Rollen und Datenscopes den Auftrag und seine Abnahmekriterien an OpenAI. Der
explizite Verbindungstest verwendet einen synthetischen öffentlichen Auftrag und
startet keinen Coding-Agenten. Die lokale Budgetanzeige ist konservativ und
ersetzt nicht die OpenAI-Abrechnung. API-Coding-Worker sind entsprechend der
gespeicherten Routen freigeschaltet. Abos haben kein Dollarbudget; API-Routen
nutzen das freigegebene Monatsbudget, ohne zusätzliches Standard-Tasklimit.

Über dem Eingabefeld **Auto-Routing** einschalten und danach den Arbeitsauftrag
normal absenden. Der Hauptagent erstellt die nötigen Aufgaben selbst. Das
Workspace-/Agent-Panel und eine Statuszeile im Hauptchat zeigen Phase, Modell,
Routing-Grund, Decisions, Checks und Review. **Strg+K → Orchestrator-Status /
Auto-Routing** öffnet die Anzeige ebenfalls. Normale Berechtigungsprüfungen
und unklare Prozesszustände bleiben verbindlich.

Für den bestehenden lokalen Windows-Controller und Paseo ab 0.15.2 eingerichtet.
SDK, Daemon und Plugin müssen bei Upgrades gemeinsam geprüft werden.

<!--
OVERVIEW.md is required to list your plugin in the registry. Keep it beside
paseo-plugin.json in your repository at the pinned commit and in your npm package.
Replace this comment with useful facts before publishing.

This overview is for people choosing a plugin in Paseo, on the plugin page under
its install command. README assumes a GitHub audience and includes technical
details, installation instructions, and badges. Long, AI-generated READMEs leave
people reading past that material to understand what the plugin does.

Write these parts in order, including only what helps someone decide to install:

1. Describe what your plugin is and does in plain terms first.
2. Explain how it works only when it is not obvious.
3. Explain setup when needed: settings, accounts, tokens, providers, tools, or
   other plugins. Include applicable daemon version and operating system
   requirements. Setup guidance is allowed; installation instructions are not.
4. Explain capabilities and settings worth understanding, what each option does,
   what the plugin reads or sends and where, permissions, and known limits.

Length follows complexity; a theme needs one paragraph. Choose headings only
when they help. Use sentence case and plain factual language, with no em dashes.
Omit installation commands, badges, changelog, contributing or license sections,
marketing, and unsupported claims. Avoid implementation filler such as empty
cleanup functions, theme-token field lists, or lists of absent features.

To translate the overview, add a whole copy beside this file named for the
language, such as OVERVIEW.zh-CN.md. Readers in that language see it instead.
-->
