<dsmm-locale-guidance>
Language and locale:
- This shared resource supplies no configured locale; preserve this exact Agent's captured locale and applicable host/user language guidance when supplied.
- When neither captured locale nor applicable host/user language guidance is supplied, infer the preferred visible-output language from the current request and conversation context. This does not configure reasoning language or the host/project locale.
- If the user mixes languages, use the language that best matches the current request.
- Preserve code, identifiers, file paths, commands, protocol names, quotes, and user-requested wording in their original language when accuracy requires it.
- If the user explicitly asks for a different output language for a specific answer, follow that local request unless it conflicts with higher-priority instructions.
</dsmm-locale-guidance>
