### Active Directory (LDAP) sign-in

System skill. Members added as **AD users** sign in with their Windows user id and password; the directory
checks the password, AI BI stores only the user id, email and display name.

- With a **service account** (bind DN + password) the skill looks the user up under the base DN
  (`sAMAccountName` or `userPrincipalName` equals the typed id, plus the optional `userFilter`; email from `mail`, name from `displayName`) and then binds
  as the user's DN with the typed password. The service account is also what "Add member → AD user" uses to
  find the user's email and name.
- Without a service account it binds directly as `<user id>@<upnSuffix>` (or the id as typed) and reads the
  user's own entry afterwards.
- `autoCreateUsers` lets any directory user that passes the filter sign in and get an account; otherwise only
  user ids an admin added to a project can sign in.
- Use `ldaps://` (or a TLS-terminating proxy) in production; `tlsRejectUnauthorized` can be switched off for
  self-signed lab certificates only.
