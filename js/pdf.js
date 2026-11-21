const cleanup = input => String(input ?? '–').replaceAll('≥', '>=').replaceAll('≤', '<=')
  .replaceAll('Ω', 'Ohm').replaceAll('µ', 'u').replace(/[^\x20-\xff\n]/g, '?');
export function makePdf(report) {
  const jsPDF = globalThis.jspdf?.jsPDF;
  if (!jsPDF) throw Error('PDF-Bibliothek fehlt. Bitte assets/vendor mit hochladen.');
  const pdf = new jsPDF({ format: 'a4', unit: 'mm' });
  const width = 180;
  let y;
  function header() {
    pdf.setFontSize(19);
    pdf.setTextColor('#004d30');
    pdf.text('HOGAbusiness', 15, 18);
    pdf.setFontSize(10);
    pdf.text('TESTVERSION - FIKTIVE TESTDATEN', 15, 25);
    pdf.line(15, 30, 195, 30);
    pdf.setTextColor('#202322');
    y = 37;
  }
  function line(value, size = 10) {
    pdf.setFontSize(size);
    for (const part of pdf.splitTextToSize(cleanup(value), width)) {
      if (y > 278) { pdf.addPage(); header(); pdf.setFontSize(size); }
      pdf.text(part, 15, y);
      y += size > 11 ? 7 : 5;
    }
  }
  const row = (label, value) => line(label + ': ' + (value || '–'));
  const section = label => { y += 3; line(label, 13); };
  header();
  line(report.corrects ? 'Berichtigung zum Prüfprotokoll' : 'Prüfprotokoll', 15);
  row('Nummer', report.id);
  row('Formatversion', report.format);
  row('Archiviert', report.at);
  row('Auftraggeber', [report.tenant.name, report.tenant.contact].filter(Boolean).join(' · '));
  row('Prüfer', report.examiner.name);
  const d = report.device;
  row('Gerät', [d.name, d.inventory, report.deviceId].join(' · '));
  if (report.corrects) {
    row('Original', report.corrects);
    row('Grund', report.reason);
    row('Berichtigung', report.note);
  } else {
    row('Standort', [report.location?.name, report.location?.address].filter(Boolean).join(' · '));
    row('Typenschild', [d.manufacturer, d.model, d.serial, d.voltage, d.power].filter(Boolean).join(' · '));
    row('Schutzklasse und Anschluss', [d.protection, d.connection].join(' · '));
    row('Gerätebesonderheiten', [d.conditions, d.notes].filter(Boolean).join(' · '));
    row('Prüfdienstleister', report.provider);
    row('Prüftag und Prüfart', report.preparation.day + ' · ' + report.preparation.type);
    row('Prüfgrundlage', report.preparation.basis);
    row('Profil', report.profile.label + ' · V' + report.profile.version);
    row('Messgerät', report.equipment.name + ' · ' + report.equipment.serial + ' · Kalibrierdatum ' + report.equipment.calibration);
    row('Eignung und Messaufbau', report.preparation.suitability);
    section('Sichtprüfung');
    for (const v of report.visual) row(v.point, [v.result, v.severity, v.note].filter(Boolean).join(' · '));
    for (const [name, label] of Object.entries({ protective: 'Schutzleiterprüfung', insulation: 'Isolationsprüfung', leakage: 'Ableitstromprüfung' })) {
      const stage = report.stages[name];
      section(label);
      line([stage.status || 'Nicht dokumentiert', stage.reason].filter(Boolean).join(' · '));
      const groups = Map.groupBy ? Map.groupBy(stage.points, p => p.method + ' / ' + p.unit) : stage.points.reduce((map, p) => {
        const group = p.method + ' / ' + p.unit;
        map.set(group, [...(map.get(group) || []), p]);
        return map;
      }, new Map());
      for (const [group, points] of groups) {
        const exact = points.filter(p => p.operator === '=').map(p => p.value);
        if (exact.length > 1) row('Erfasste Extremwerte (' + group + ')', Math.min(...exact) + ' bis ' + Math.max(...exact));
      }
      for (const p of stage.points) {
        row(p.point, [p.method, p.operator + ' ' + p.value + ' ' + p.unit, p.rating].join(' · '));
        row('Grenzwert / Quelle', (p.limit === null ? 'Kein Zahlenwert' : p.limitOperator + ' ' + p.limit + ' ' + p.unit) + ' · ' + p.source);
        row('Messbedingungen / Zeitpunkt', [p.conditions, p.at, p.note].filter(Boolean).join(' · '));
      }
    }
    section('Funktionsprüfung und Abschluss');
    row('Funktion', [report.functionTest.result, report.functionTest.note].filter(Boolean).join(' · '));
    row('Gesamtergebnis', report.outcome);
    row('Fachliche Bewertung', report.assessment);
    row('Maßnahmen', report.actions);
    if (report.outcome === 'Bestanden') row('Nächste Fälligkeit', report.nextDue);
  }
  for (let n = 1; n <= pdf.getNumberOfPages(); n++) {
    pdf.setPage(n);
    pdf.setFontSize(9);
    pdf.text('Protokoll ' + cleanup(report.id) + ' · Seite ' + n + ' / ' + pdf.getNumberOfPages(), 15, 289);
  }
  return pdf;
}
