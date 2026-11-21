export async function connectFirebase(config, connectEmulators) {
  let appApi, authApi, functionsApi;
  try {
    [appApi, authApi, functionsApi] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/11.10.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/11.10.0/firebase-auth.js'),
      import('https://www.gstatic.com/firebasejs/11.10.0/firebase-functions.js')
    ]);
  } catch (cause) {
    throw Error('Firebase-Bibliotheken konnten nicht geladen werden. Bitte Internetverbindung prüfen und die Seite neu laden.', { cause });
  }

  const app = appApi.initializeApp(config, connectEmulators ? 'hbp-emulator' : 'hbp-online-test');
  const auth = authApi.getAuth(app);
  const functions = functionsApi.getFunctions(app, 'europe-west1');
  connectEmulators?.({ auth, functions, authApi, functionsApi });
  await authApi.setPersistence(auth, authApi.browserSessionPersistence);
  return { auth, authApi, callable: functionsApi.httpsCallable(functions, 'hbpCommand') };
}
