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

Ergebnis des letzten Laufs: **21/21 automatisierte Tests bestanden**
(15 Server/API, 6 Editor).

Bewertung:

- **ja**: Das erwartete Ergebnis wurde durch diese Suite automatisiert bestätigt.
- **teilweise**: Ein technischer Teil ist bestätigt, aber UX, echte Infrastruktur
  oder ein Teil der Erwartung ist offen.
- **nein**: Die geforderte Fähigkeit fehlt oder die Erwartung wird nicht erfüllt.

## PM (1/4)

| ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| PM-01 | Externer sieht nur Briefing, Zugangsdaten bleiben beim Kernteam | ja | AT-01: Dokumentfreigabe erlaubt das Briefing und verweigert die Seite „Zugangsdaten“ samt Geheimnis. |
| PM-02 | Briefing per Link mit Ablauf; Gast liest, editiert nicht, sieht keine anderen Seiten | teilweise | AT-02 bestätigt ablaufenden, schreibgeschützten und dokumentbegrenzten Bearer-Token. Eine klare Browser-Gastlink-Oberfläche ist nicht vorhanden. |
| PM-03 | Im Projektbereich nachvollziehen, wer liest bzw. mitarbeitet | ja | AT-03 bestätigt die effektive Zugriffsübersicht mit Viewer- und Editor-Rollen. |
| PM-04 | Kollegin erwähnen und Benachrichtigung erhalten | teilweise | AT-16 bestätigt die adressierte `@`-Erwähnung. Automatische Benachrichtigungen werden für Publikationen und Kommentare erzeugt, nicht für Erwähnungen. |
| PM-05 | Status-Tabelle bauen und Zellen gelb/grün färben | ja | AT-17 bestätigt farbige Tabellenzellen im echten Editor. |
| PM-06 | Jede Seite sitzt im Seitenbaum; anlegen und verschieben | ja | AT-04 bestätigt Parent-Beziehungen, Verschieben und Kindlisten. |
| PM-07 | Sommerkampagne/Briefing ohne URL in etwa einer Minute finden | teilweise | AT-14 bestätigt die technische Suche. Zeitbedarf und Auffindbarkeit benötigen einen manuellen UX-Test. |
| PM-08 | Briefing mit Überschriften und Absätzen formatieren | ja | AT-05 und AT-18 bestätigen Speicherung und Bearbeitbarkeit. |

## PM (2/4)

| ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| PM-09 | Text samt kleiner Tabelle aus Word/Docs einfügen | teilweise | AT-05/AT-18 bestätigen das Ergebnisformat und dessen Round-trip. Ein echter Word-/Google-Docs-Clipboard-Lauf bleibt manuell. |
| PM-10 | To-do-Liste anlegen und Punkt abhaken | ja | AT-05/AT-18 bestätigen Task-Listen und den gespeicherten Checked-Zustand. |
| PM-11 | Vom Briefing auf „Assets“ verlinken und folgen | ja | AT-06 speichert den internen Link und löst das Ziel über dessen Slug auf. |
| PM-12 | „Moodboard-Notizen“ anlegen und unter Assets verschieben | ja | AT-04 führt genau dieses Anlegen und Verschieben aus. |
| PM-13 | Zwei Unterseiten unter eine gemeinsame Überschrift hängen | ja | AT-04 hängt zwei Seiten unter denselben Parent. |
| PM-14 | History ansehen und frühere Version wiederherstellen bzw. diffen | ja | AT-07 bestätigt Historie, Diff und Wiederherstellung. |
| PM-15 | Zu zweit dieselbe Stelle bearbeiten, ohne stillen Datenverlust | teilweise | Yjs-Kollaboration ist implementiert; die unabhängige Suite prüft hier keinen Zwei-Browser-Konfliktlauf. |
| PM-16 | Bild einfügen und skalieren | ja | AT-19 bestätigt Bildknoten und gespeicherte Breite; die Drag-Geste selbst ist nicht Teil des Headless-Tests. |

## PM (3/4)

| ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| PM-17 | Bild skalieren, PDF/Bild anhängen und in der Seite sehen | teilweise | AT-08 bestätigt Upload/Download, AT-19 Bildbreite und PDF-Anhang. Dokumentfreigaben reichen jedoch nicht automatisch für Upload-URLs, die auf Space-Ebene autorisiert werden. |
| PM-18 | Seite ohne schweren Edit-Modus bearbeiten | teilweise | Der Editor arbeitet inline, aber „fühlt sich leicht an“ braucht einen manuellen Bedienungstest. |
| PM-19 | Testseite löschen und wiederherstellen | ja | AT-09 bestätigt Soft-Delete/Archiv und Restore. |
| PM-20 | Briefing als PDF oder Markdown mitnehmen und öffnen | ja | AT-10 exportiert und liest Markdown; damit ist die Oder-Bedingung erfüllt. |
| PM-21 | Breite Tabelle im schmalen Fenster; Sidebars einklappen | teilweise | Tabellen und responsive Layouts existieren; die schmale Viewport-Bedienung ist nicht automatisiert bestätigt. |
| PM-22 | Mitten auf langer Seite schnell bearbeiten | teilweise | Inline-Editing vermeidet einen separaten globalen Edit-Modus; Scroll-/Fokus-UX bleibt manuell. |
| PM-23 | Zwei Blöcke oder Tabellen nebeneinander | ja | AT-20 bestätigt ein Zwei-Spalten-Layout mit Tabelle. |
| PM-24 | Für eine Person nachvollziehen, was sie sehen darf | ja | AT-03 bestätigt die effektive, quellengenau aufgelöste Dokumentzugriffsliste. |

## PM (4/4)

| ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| PM-25 | Auf langer Seite per Inhaltsverzeichnis zum Abschnitt springen | nein | Für normale Wiki-Dokumente ist kein Inhaltsverzeichnis-/Outline-Element vorhanden. Die Docs-Website besitzt eine Outline, nicht der Workspace-Editor. |
| PM-26 | Eigene Notizen persönlich ablegen | teilweise | Ein privater Space ist als Workaround möglich; einen ausdrücklich persönlichen Notizbereich gibt es nicht. |
| PM-27 | Figma- oder Video-Element einbetten | ja | AT-21 bestätigt beide Elementtypen als Dokumentknoten. |
| PM-28 | Seite umbenennen und alten Link öffnen | ja | AT-11 bestätigt, dass die stabile Slug-Adresse nach Umbenennung weiter auf dieselbe Seite zeigt. |

## Abschluss — PM

- **Alltag täglich nutzen?** Ja, mit Einschränkungen. Kernabläufe wie Baum,
  Rich-Text, Tabellen, Aufgaben, Suche, Revisionen, Kollaboration und stabile
  Links sind vorhanden. Offene UX-Punkte sind vor allem Gastlinks,
  Erwähnungsbenachrichtigungen, Inhaltsverzeichnis und persönliche Notizen.
- **Persönliche Empfehlung:** Für ein Kernteam ist ein Pilot sinnvoll. Vor einer
  breiten externen Nutzung sollte die Kombination aus dokumentbezogener Freigabe
  und Anhangszugriff geschlossen sowie der Gastlink-Ablauf produktisiert werden.
- **Welches System ist besser?** Nicht beantwortbar: Die Unterlage enthält keine
  Ergebnisse eines zweiten Systems, daher wäre ein Vergleich erfunden.
- **Blocker/Dealbreaker:** Anhänge einer dokumentbezogen freigegebenen Seite sind
  nicht mit derselben Dokumentberechtigung geschützt/erreichbar; kein fertiger
  Gastlink-Flow; keine Mention-Benachrichtigung; kein Wiki-Inhaltsverzeichnis.

## IT / Technik (1/4)

| ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| IT-01 | S&V-Mitarbeiter meldet sich über Firmenkonto an; Name/E-Mail stimmen | teilweise | OAuth2 und Profilübernahme sind vorgesehen. Ein echter S&V-IdP war in dieser Umgebung nicht konfiguriert und wurde nicht gegen Produktionsclaims getestet. |
| IT-02 | Person ohne Erlaubnis versucht sich anzumelden; Anmeldung wird abgewiesen | nein | AT-12 bestätigt verweigerten Inhaltszugriff, nicht verweigerte Anmeldung. Mit aktivierter E-Mail-Anmeldung kann ein Konto erstellt werden; es erhält lediglich keinen Space-Zugriff. |
| IT-03 | Externer mit Konto sieht nur Freigegebenes | ja | AT-01 bestätigt Briefing-Zugriff und Sperre der internen Seite. |
| IT-04 | Extern ohne Vollkonto: Link mit Ablauf, nur lesen | teilweise | AT-02 bestätigt den Backend-Tokenvertrag. Der nutzerfertige Browser-Gastlink fehlt. |
| IT-05 | Gruppe steuert Lesen und Mitarbeiten | teilweise | AT-13 bestätigt einen Gruppen-Grant für Lesen. Ein realer IdP-Gruppenlauf mit Editor-Rolle wurde in dieser Suite nicht ausgeführt. |
| IT-06 | Extern nur Briefing plus Ausnahme tiefer im Baum | teilweise | Dokument- und Dokumentbaum-ACLs sind vorhanden; die konkrete verschachtelte Ausnahme ist in diesem Lauf nicht als eigener Fall ausgeführt. |
| IT-07 | Direkte PDF-URL ohne Briefing-Recht liefert nicht | ja | AT-08 bestätigt 401/403 ohne Preisgabe des Dateiinhalts. |
| IT-08 | Eingeschränktes Konto: Navigation und direkte URL sind beide dicht | ja | AT-12 bestätigt verweigerte Liste und direkte URL; AT-01 bestätigt den begrenzten positiven Zugriff. |

## IT / Technik (2/4)

| ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| IT-09 | Confluence-Bereich/Export übernehmen | nein | Es gibt einen generischen, dateibasierten One-shot-Importer, aber keinen Confluence-Adapter oder geprüften Confluence-Exportlauf. |
| IT-10 | xWiki-Bereich übernehmen | nein | Kein nativer xWiki-Adapter und kein geprüfter xWiki-Exportlauf vorhanden. |
| IT-11 | Confluence-Rest und aktuelles xWiki/Delta in einem klaren Weg übernehmen | nein | Kein kombinierter oder Delta-fähiger Migrationspfad implementiert. |
| IT-12 | Nach Import Links, Bilder und Querverweise prüfen | teilweise | Der dokumentierte Importer schreibt lokale Asset-Referenzen um und validiert sie, wurde hier aber nicht mit einem realen Confluence-/xWiki-Bestand ausgeführt. |
| IT-13 | Seite/Bereich importieren und exportieren; Wechsel/Delta möglich | teilweise | One-shot-Import und Markdown-Export (AT-10) sind vorhanden; Round-trip und Delta fehlen. |
| IT-14 | Backup erstellen und Restore stichprobenartig prüfen | nein | Docker-Volume/DB-Dateien können extern gesichert werden, aber es gibt keinen dokumentierten und in dieser Suite bestandenen Backup-/Restore-Lauf. |
| IT-15 | Linux/Docker und Update-Weg bestätigen | teilweise | Dockerfile und Compose-Konfiguration sind vorhanden. Ein Image-Update mit Datenmigration/Rollback wurde nicht ausgeführt. |
| IT-16 | Server-Datenbank wie PostgreSQL, nicht nur SQLite | nein | Unterstützt werden lokale oder gehostete libSQL-Datenbanken; PostgreSQL bzw. ein Nicht-SQLite-Backend ist nicht vorhanden. |

## IT / Technik (3/4)

| ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| IT-17 | LDAP prüfen oder OIDC/Firmenkonto als ausreichend dokumentieren | teilweise | Generisches OAuth2 ist implementiert; LDAP fehlt und der konkrete S&V-OIDC-Vertrag wurde nicht abgenommen. |
| IT-18 | Große praxisnahe Datei hochladen | teilweise | Der Uploadpfad akzeptiert Dateien bis 1,25 GB; AT-08 bestätigt einen echten Upload, aber keinen praxisnahen Großdatei-/Timeout-/Proxy-Test. |
| IT-19 | Seite umbenennen und alte Bookmarks prüfen | ja | AT-11 bestätigt die stabile alte Adresse. |
| IT-20 | Technischen/fachlichen Begriff suchen | ja | AT-14 erstellt einen eindeutigen Fachbegriff und findet die richtige Seite. |
| IT-21 | In Navigation erkennen, dass tiefere Seite eingeschränkt ist | nein | Nicht lesbare Seiten werden gefiltert; eine sichtbare Kennzeichnung der Einschränkung für tiefere Seiten ist nicht vorhanden. |
| IT-22 | LDAP-Gruppensync prüfen oder als ungetestet markieren | teilweise | LDAP-Gruppensync ist nicht vorhanden. OAuth/IdP-Gruppen-Sync existiert, wurde in dieser unabhängigen Suite aber nicht gegen einen echten IdP ausgeführt. |
| IT-23 | Stabile Benutzer-ID und Avatar | teilweise | Benutzer besitzen stabile interne IDs; OAuth-Profile können Avatare übernehmen. AT-16 zeigt jedoch, dass gespeicherte Erwähnungen die E-Mail als Identität verwenden. |
| IT-24 | Archiv oder Bereichsvorlage anstoßen | ja | AT-09 bestätigt das Archiv einschließlich Wiederherstellung; damit ist die Oder-Bedingung erfüllt. |

## IT / Technik (4/4)

| ID | Testfall | Ergebnis | Befund |
|---|---|---:|---|
| IT-25 | Audit-Logs als Textdatei oder Export finden | teilweise | AT-15 bestätigt auswertbares JSON als Textantwort. Eine dedizierte Download-/Exportfunktion fehlt. |

## Abschluss — IT / Technik

- **Produktionstauglich On-Premises?** Noch nein für den beschriebenen
  Unternehmenseinsatz. Der Docker-/Single-Binary-Betrieb und die zentralen ACLs
  sind eine gute Basis, aber belastbarer Backup/Restore, reale S&V-SSO-Abnahme,
  Migrationspfade und dokumentbezogener Anhangszugriff fehlen als Nachweise bzw.
  Fähigkeiten.
- **Persönliche Empfehlung:** Als kontrollierten On-Prem-Pilot betreiben, nicht
  sofort als alleinige produktive Wissensquelle. Vor Go-live die vier Blocker
  unten mit realen Daten und IdP testen.
- **Welches System ist besser?** Ohne Vergleichssystem und dessen Testergebnisse
  nicht seriös entscheidbar.
- **Blocker/Dealbreaker:** kein bestandener Backup/Restore; kein Confluence-/xWiki-
  Migrationslauf; kein PostgreSQL/Nicht-SQLite-Backend; keine produktive S&V-SSO-
  Abnahme; Scope-Mismatch zwischen Dokumentfreigabe und Upload-Zugriff.
- **Offene Ops-Punkte:** Update/Rollback, Restore-Zeit, Uploadgrenzen durch Reverse
  Proxy, IdP-Claim-Mapping, Gruppenänderungen im laufenden Betrieb, Audit-Retention,
  Monitoring und Kapazitätsplanung für libSQL/Uploads.
