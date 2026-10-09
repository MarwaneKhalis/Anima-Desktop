# Signature de l’application Windows

Les builds de vérification CI restent non signés. `electron-builder` peut signer l’installateur NSIS et ses exécutables si le build est lancé sur une machine Windows de confiance avec un certificat de signature de code valide au format PFX/PKCS#12.

Ne stockez jamais le PFX ou son mot de passe dans Git ou dans les variables d’un workflow CI. Pour une publication, utilisez une machine de confiance et configurez les variables uniquement le temps du build :

```powershell
$env:WIN_CSC_LINK = "C:\chemin\vers\certificat.pfx"
$securePassword = Read-Host "Mot de passe du certificat" -AsSecureString
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $env:WIN_CSC_KEY_PASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  pnpm desktop:dist
  if ($LASTEXITCODE -ne 0) { throw "Le build de l’installateur a échoué." }
} finally {
  Remove-Item Env:WIN_CSC_LINK -ErrorAction SilentlyContinue
  Remove-Item Env:WIN_CSC_KEY_PASSWORD -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
}
```

Vérifiez ensuite l’installateur généré avant de le distribuer :

```powershell
$installer = Get-ChildItem "release\Anima Connect Setup *.exe" | Select-Object -First 1
if (!$installer) { throw "Installateur introuvable." }
Get-AuthenticodeSignature $installer.FullName | Format-List Status, SignerCertificate
```

Le statut doit être `Valid` et le certificat doit identifier l’éditeur attendu. Une signature valide établit l’identité de l’éditeur et l’intégrité du fichier ; SmartScreen peut encore avertir tant que la réputation de l’éditeur et de la version n’est pas établie. Aucun installateur signé ne peut être produit tant que l’éditeur ne fournit pas de certificat valide.
