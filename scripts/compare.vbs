' compare.vbs — Legal blackline comparison of two DOCX files via MS Word COM
' Usage: cscript //nologo compare.vbs <original.docx> <revised.docx> <authorName>
'
' Opens the original document, runs a legal blackline comparison against the
' revised document using the given author name, and leaves the result open
' in Word for the user to review.

If WScript.Arguments.Count < 3 Then
  WScript.Echo "Usage: cscript //nologo compare.vbs <original.docx> <revised.docx> <authorName>"
  WScript.Quit 1
End If

Dim originalPath, revisedPath, authorName
originalPath = WScript.Arguments(0)
revisedPath  = WScript.Arguments(1)
authorName   = WScript.Arguments(2)

Dim fso
Set fso = CreateObject("Scripting.FileSystemObject")
If Not fso.FileExists(originalPath) Then
  WScript.Echo "Original file not found: " & originalPath
  WScript.Quit 1
End If
If Not fso.FileExists(revisedPath) Then
  WScript.Echo "Revised file not found: " & revisedPath
  WScript.Quit 1
End If

Dim wordApp
Set wordApp = CreateObject("Word.Application")
wordApp.Visible = True

Dim originalDoc
Set originalDoc = wordApp.Documents.Open(originalPath, , True)

' wdCompareDestinationNew = 2 (create new document with comparison)
' wdGranularityWordLevel = 1
originalDoc.Compare revisedPath, authorName, 2, True, True, False, False, False

' Close the original (read-only) document, keep only the comparison result
originalDoc.Close 0 ' wdDoNotSaveChanges = 0

Set originalDoc = Nothing
Set wordApp = Nothing
Set fso = Nothing
