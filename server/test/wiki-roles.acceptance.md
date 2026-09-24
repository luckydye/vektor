# Abnahmetests: Wiki-Rollen und Anwendungsfälle

Quelle: `SV_Wiki-Testfaelle_Rollen_2026-08-fk.pptx` (August 2026)

Stand: 14. August 2026

## Ausführung

```sh
task test:wiki-roles
```

Die Suite ist unabhängig von den übrigen Tests. Sie startet einen eigenen
In-Memory-Server, legt eigene Benutzer, Rollen, Seiten, Revisionen und Uploads
an und instanziiert für die Editor-Fälle einen eigenen Tiptap-Editor.

Ergebnis des letzten Laufs: **21/21 automatisierte Produkttests bestanden**
(15 Server/API, 6 Editor). Zusätzlich sind **16 Kriterien durch Stakeholder-
Abnahme als gelöst bestätigt** und **6 weitere Kriterien als `todo`
ausdrücklich im Testlauf erfasst**, weil sie manuelle Bedienung, externe Systeme
oder noch fehlende Produktfähigkeiten benötigen.

Bewertung:

- **ja**: Das erwartete Ergebnis wurde durch diese Suite automatisiert bestätigt.
- **teilweise**: Ein technischer Teil ist bestätigt, aber UX, echte Infrastruktur
  oder ein Teil der Erwartung ist offen.
- **nein**: Die geforderte Fähigkeit fehlt oder die Erwartung wird nicht erfüllt.

## Referenzierbare Kriterien-IDs

Die IDs sind dauerhaft und dürfen bei späteren Änderungen nicht neu nummeriert
oder wiederverwendet werden:

- `PM-01` bis `PM-28`: fachliche und alltägliche Nutzungskriterien
- `IT-01` bis `IT-25`: technische und betriebliche Kriterien
- `PM-A01` bis `PM-A04`: abschließende PM-Bewertungen
- `IT-A01` bis `IT-A05`: abschließende IT-/Betriebsbewertungen
- `AT-01` bis `AT-21`: automatisierte Nachweise aus dieser Suite

Referenzformat in Tickets und Entscheidungen: `Wiki-Rollen/<Kriterien-ID>`, zum
Beispiel `Wiki-Rollen/PM-17` oder `Wiki-Rollen/IT-14`.

## PM (1/4)

| Kriterien-ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| PM-01 | Externer sieht nur Briefing, Zugangsdaten bleiben beim Kernteam | ja | AT-01: Dokumentfreigabe erlaubt das Briefing und verweigert die Seite „Zugangsdaten“ samt Geheimnis. |
| PM-02 | Briefing per Link mit Ablauf; Gast liest, editiert nicht, sieht keine anderen Seiten | teilweise | AT-02 bestätigt ablaufenden, schreibgeschützten und dokumentbegrenzten Bearer-Token. Eine klare Browser-Gastlink-Oberfläche ist nicht vorhanden. |
| PM-03 | Im Projektbereich nachvollziehen, wer liest bzw. mitarbeitet | ja | AT-03 bestätigt die effektive Zugriffsübersicht mit Viewer- und Editor-Rollen. |
| PM-04 | Kollegin erwähnen und Benachrichtigung erhalten | teilweise | AT-16 bestätigt die adressierte `@`-Erwähnung. Erwähnte Personen erhalten beim Publizieren die allgemeine Publikations-E-Mail; eine eigenständige, unmittelbare Mention-Benachrichtigung gibt es nicht. |
| PM-05 | Status-Tabelle bauen und Zellen gelb/grün färben | ja | AT-17 bestätigt farbige Tabellenzellen im echten Editor. |
| PM-06 | Jede Seite sitzt im Seitenbaum; anlegen und verschieben | ja | AT-04 bestätigt Parent-Beziehungen, Verschieben und Kindlisten. |
| PM-07 | Sommerkampagne/Briefing ohne URL in etwa einer Minute finden | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| PM-08 | Briefing mit Überschriften und Absätzen formatieren | ja | AT-05 und AT-18 bestätigen Speicherung und Bearbeitbarkeit. |

## PM (2/4)

| Kriterien-ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| PM-09 | Text samt kleiner Tabelle aus Word/Docs einfügen | teilweise | AT-05/AT-18 bestätigen das Ergebnisformat und dessen Round-trip. Ein echter Word-/Google-Docs-Clipboard-Lauf bleibt manuell. |
| PM-10 | To-do-Liste anlegen und Punkt abhaken | ja | AT-05/AT-18 bestätigen Task-Listen und den gespeicherten Checked-Zustand. |
| PM-11 | Vom Briefing auf „Assets“ verlinken und folgen | ja | AT-06 speichert den internen Link und löst das Ziel über dessen Slug auf. |
| PM-12 | „Moodboard-Notizen“ anlegen und unter Assets verschieben | ja | AT-04 führt genau dieses Anlegen und Verschieben aus. |
| PM-13 | Zwei Unterseiten unter eine gemeinsame Überschrift hängen | ja | AT-04 hängt zwei Seiten unter denselben Parent. |
| PM-14 | History ansehen und frühere Version wiederherstellen bzw. diffen | ja | AT-07 bestätigt Historie, Diff und Wiederherstellung. |
| PM-15 | Zu zweit dieselbe Stelle bearbeiten, ohne stillen Datenverlust | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| PM-16 | Bild einfügen und skalieren | ja | AT-19 bestätigt Bildknoten und gespeicherte Breite; die Drag-Geste selbst ist nicht Teil des Headless-Tests. |

## PM (3/4)

| Kriterien-ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| PM-17 | Bild skalieren, PDF/Bild anhängen und in der Seite sehen | teilweise | AT-08 bestätigt Upload/Download, AT-19 Bildbreite und PDF-Anhang. Dokumentfreigaben reichen jedoch nicht automatisch für Upload-URLs, die auf Space-Ebene autorisiert werden. |
| PM-18 | Seite ohne schweren Edit-Modus bearbeiten | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| PM-19 | Testseite löschen und wiederherstellen | ja | AT-09 bestätigt Soft-Delete/Archiv und Restore. |
| PM-20 | Briefing als PDF oder Markdown mitnehmen und öffnen | ja | AT-10 exportiert und liest Markdown; damit ist die Oder-Bedingung erfüllt. |
| PM-21 | Breite Tabelle im schmalen Fenster; Sidebars einklappen | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| PM-22 | Mitten auf langer Seite schnell bearbeiten | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| PM-23 | Zwei Blöcke oder Tabellen nebeneinander | ja | AT-20 bestätigt ein Zwei-Spalten-Layout mit Tabelle. |
| PM-24 | Für eine Person nachvollziehen, was sie sehen darf | ja | AT-03 bestätigt die effektive, quellengenau aufgelöste Dokumentzugriffsliste. |

## PM (4/4)

| Kriterien-ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| PM-25 | Auf langer Seite per Inhaltsverzeichnis zum Abschnitt springen | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| PM-26 | Eigene Notizen persönlich ablegen | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| PM-27 | Figma- oder Video-Element einbetten | ja | AT-21 bestätigt beide Elementtypen als Dokumentknoten. |
| PM-28 | Seite umbenennen und alten Link öffnen | ja | AT-11 bestätigt, dass die stabile Slug-Adresse nach Umbenennung weiter auf dieselbe Seite zeigt. |

## Abschluss — PM

- **PM-A01 — Alltag täglich nutzen?** Ja, mit Einschränkungen. Kernabläufe wie Baum,
  Rich-Text, Tabellen, Aufgaben, Suche, Revisionen, Kollaboration und stabile
  Links sind vorhanden. Offene UX-Punkte sind vor allem Gastlinks und eine
  eigenständige, unmittelbare Erwähnungsbenachrichtigung.
- **PM-A02 — Persönliche Empfehlung:** Für ein Kernteam ist ein Pilot sinnvoll. Vor einer
  breiten externen Nutzung sollte die Kombination aus dokumentbezogener Freigabe
  und Anhangszugriff geschlossen sowie der Gastlink-Ablauf produktisiert werden.
- **PM-A03 — Welches System ist besser?** Nicht beantwortbar: Die Unterlage enthält keine
  Ergebnisse eines zweiten Systems, daher wäre ein Vergleich erfunden.
- **PM-A04 — Blocker/Dealbreaker:** Anhänge einer dokumentbezogen freigegebenen Seite sind
  nicht mit derselben Dokumentberechtigung geschützt/erreichbar; kein fertiger
  Gastlink-Flow; keine eigenständige, unmittelbare Mention-Benachrichtigung.

## IT / Technik (1/4)

| Kriterien-ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| IT-01 | S&V-Mitarbeiter meldet sich über Firmenkonto an; Name/E-Mail stimmen | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| IT-02 | Person ohne Erlaubnis versucht sich anzumelden; Anmeldung wird abgewiesen | nein | AT-12 bestätigt verweigerten Inhaltszugriff, nicht verweigerte Anmeldung. Mit aktivierter E-Mail-Anmeldung kann ein Konto erstellt werden; es erhält lediglich keinen Space-Zugriff. |
| IT-03 | Externer mit Konto sieht nur Freigegebenes | ja | AT-01 bestätigt Briefing-Zugriff und Sperre der internen Seite. |
| IT-04 | Extern ohne Vollkonto: Link mit Ablauf, nur lesen | teilweise | AT-02 bestätigt den Backend-Tokenvertrag. Der nutzerfertige Browser-Gastlink fehlt. |
| IT-05 | Gruppe steuert Lesen und Mitarbeiten | teilweise | AT-13 bestätigt einen Gruppen-Grant für Lesen. Ein realer IdP-Gruppenlauf mit Editor-Rolle wurde in dieser Suite nicht ausgeführt. |
| IT-06 | Extern nur Briefing plus Ausnahme tiefer im Baum | teilweise | Dokument- und Dokumentbaum-ACLs sind vorhanden; die konkrete verschachtelte Ausnahme ist in diesem Lauf nicht als eigener Fall ausgeführt. |
| IT-07 | Direkte PDF-URL ohne Briefing-Recht liefert nicht | ja | AT-08 bestätigt 401/403 ohne Preisgabe des Dateiinhalts. |
| IT-08 | Eingeschränktes Konto: Navigation und direkte URL sind beide dicht | ja | AT-12 bestätigt verweigerte Liste und direkte URL; AT-01 bestätigt den begrenzten positiven Zugriff. |

## IT / Technik (2/4)

| Kriterien-ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| IT-09 | Confluence-Bereich/Export übernehmen | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| IT-10 | xWiki-Bereich übernehmen | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| IT-11 | Confluence-Rest und aktuelles xWiki/Delta in einem klaren Weg übernehmen | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| IT-12 | Nach Import Links, Bilder und Querverweise prüfen | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| IT-13 | Seite/Bereich importieren und exportieren; Wechsel/Delta möglich | teilweise | One-shot-Import und Markdown-Export (AT-10) sind vorhanden; Round-trip und Delta fehlen. |
| IT-14 | Backup erstellen und Restore stichprobenartig prüfen | nein | Docker-Volume/DB-Dateien können extern gesichert werden, aber es gibt keinen dokumentierten und in dieser Suite bestandenen Backup-/Restore-Lauf. |
| IT-15 | Linux/Docker und Update-Weg bestätigen | teilweise | Dockerfile und Compose-Konfiguration sind vorhanden. Ein Image-Update mit Datenmigration/Rollback wurde nicht ausgeführt. |
| IT-16 | Server-Datenbank wie PostgreSQL, nicht nur SQLite | nein | Unterstützt werden lokale oder gehostete libSQL-Datenbanken; PostgreSQL bzw. ein Nicht-SQLite-Backend ist nicht vorhanden. |

## IT / Technik (3/4)

| Kriterien-ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| IT-17 | LDAP prüfen oder OIDC/Firmenkonto als ausreichend dokumentieren | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| IT-18 | Große praxisnahe Datei hochladen | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| IT-19 | Seite umbenennen und alte Bookmarks prüfen | ja | AT-11 bestätigt die stabile alte Adresse. |
| IT-20 | Technischen/fachlichen Begriff suchen | ja | AT-14 erstellt einen eindeutigen Fachbegriff und findet die richtige Seite. |
| IT-21 | In Navigation erkennen, dass tiefere Seite eingeschränkt ist | nein | Nicht lesbare Seiten werden gefiltert; eine sichtbare Kennzeichnung der Einschränkung für tiefere Seiten ist nicht vorhanden. |
| IT-22 | LDAP-Gruppensync prüfen oder als ungetestet markieren | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| IT-23 | Stabile Benutzer-ID und Avatar | ja | Am 14. August 2026 durch Stakeholder-Abnahme als gelöst bestätigt. |
| IT-24 | Archiv oder Bereichsvorlage anstoßen | ja | AT-09 bestätigt das Archiv einschließlich Wiederherstellung; damit ist die Oder-Bedingung erfüllt. |

## IT / Technik (4/4)

| Kriterien-ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| IT-25 | Audit-Logs als Textdatei oder Export finden | teilweise | AT-15 bestätigt auswertbares JSON als Textantwort. Eine dedizierte Download-/Exportfunktion fehlt. |

## Abschluss — IT / Technik

- **IT-A01 — Produktionstauglich On-Premises?** Noch nein für den beschriebenen
  Unternehmenseinsatz. Der Docker-/Single-Binary-Betrieb, die zentralen ACLs,
  S&V-SSO-Abnahme und Migrationspfade sind bestätigt; belastbarer Backup/Restore,
  ein Nicht-SQLite-Backend und dokumentbezogener Anhangszugriff bleiben offen.
- **IT-A02 — Persönliche Empfehlung:** Als kontrollierten On-Prem-Pilot betreiben, nicht
  sofort als alleinige produktive Wissensquelle. Vor Go-live die vier Blocker
  unten mit realen Daten und IdP testen.
- **IT-A03 — Welches System ist besser?** Ohne Vergleichssystem und dessen Testergebnisse
  nicht seriös entscheidbar.
- **IT-A04 — Blocker/Dealbreaker:** kein bestandener Backup/Restore; kein
  PostgreSQL/Nicht-SQLite-Backend; Scope-Mismatch zwischen Dokumentfreigabe und
  Upload-Zugriff.
- **IT-A05 — Offene Ops-Punkte:** Update/Rollback, Restore-Zeit, Uploadgrenzen durch Reverse
  Proxy, Audit-Retention, Monitoring und Kapazitätsplanung für libSQL/Uploads.
