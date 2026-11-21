// Öffentliche Web-Konfiguration aus Firebase → Projekteinstellungen → Meine Apps.
// Ausschließlich öffentliche SDK-Werte und Auth-Mandanten-IDs eintragen.
// enabled erst nach Einrichtung und Freigabe des Online-Tests auf true setzen.
export const firebaseConfig = {
  enabled: false,
  firebase: {
    projectId: 'hogasports',
    apiKey: '',
    authDomain: '',
    appId: ''
  },
  authTenants: {
    staff: '',    // Identity Platform: HOGAbusiness-Administration
    customer: ''  // Identity Platform: HOGAbusiness-Kundenportal
  }
};
