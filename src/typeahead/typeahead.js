angular.module('ui.bootstrap.typeahead', ['ui.bootstrap.position'])

/**
 * A helper service that can parse typeahead's syntax (string provided by users)
 * Extracted to a separate service for ease of unit testing
 */
  .factory('typeaheadParser', ['$parse', function ($parse) {

  //                      00000111000000000000022200000000000000003333333333333330000000000044000
  var TYPEAHEAD_REGEXP = /^\s*(.*?)(?:\s+as\s+(.*?))?\s+for\s+(?:([\$\w][\$\w\d]*))\s+in\s+(.*)$/;

  return {
    parse:function (input) {

      var match = input.match(TYPEAHEAD_REGEXP), modelMapper, viewMapper, source;
      if (!match) {
        throw new Error(
          "Expected typeahead specification in form of '_modelValue_ (as _label_)? for _item_ in _collection_'" +
            " but got '" + input + "'.");
      }

      return {
        itemName:match[3],
        source:$parse(match[4]),
        viewMapper:$parse(match[2] || match[1]),
        modelMapper:$parse(match[1])
      };
    }
  };
}])

  .directive('typeahead', ['$compile', '$parse', '$q', '$timeout', '$document', '$position', 'typeaheadParser', function ($compile, $parse, $q, $timeout, $document, $position, typeaheadParser) {

  var HOT_KEYS = [9, 13, 27, 38, 40];

  return {
    require:'ngModel',
    link:function (originalScope, element, attrs, modelCtrl) {

      //SUPPORTED ATTRIBUTES (OPTIONS)

      //minimal no of characters that needs to be entered before typeahead kicks-in
      var minSearch = originalScope.$eval(attrs.typeaheadMinLength);
      if (!angular.isNumber(minSearch) || minSearch < 0) { minSearch = 1; }

      //minimal wait time after last character typed before typehead kicks-in
      var waitTime = originalScope.$eval(attrs.typeaheadWaitMs) || 0;

      //should it restrict model values to the ones selected from the popup only?
      var isEditable = originalScope.$eval(attrs.typeaheadEditable) !== false;

      //binding to a variable that indicates if matches are being retrieved asynchronously
      var isLoadingSetter = $parse(attrs.typeaheadLoading).assign || angular.noop;

      // Used to avoid reopening the select dialog after a select via a click.
      var bypassReopen = false;

      //binding to a variable that provides an API to force open the select list.
      var setForceOpen = $parse(attrs.typeaheadForceOpen).assign || angular.noop;
      var getForceOpen = $parse(attrs.typeaheadForceOpen) || angular.noop;
      var forceOpenChanged = false;  // Keep track to ignore click events.
      if (attrs.typeaheadForceOpen) {
		originalScope.$watch(attrs.typeaheadForceOpen, function(newVal, oldVal) {
			if (newVal) {
				// When this is due to a click event, avoid resetting showAll.
				forceOpenChanged = true;

				// Focus the input element when the drop-down is displayed.
				// Delay this so the focus callback doesn't get called inside $apply.
				setTimeout(function(){
					element[0].focus();

					// We've had time to process the click event.
					forceOpenChanged = false;
				}, 100);
			} else {
				resetMatches();
			}
		});
      }

      //a callback executed when a match is selected
      var onSelectCallback = $parse(attrs.typeaheadOnSelect);

      var inputFormatter = attrs.typeaheadInputFormatter ? $parse(attrs.typeaheadInputFormatter) : undefined;

      //INTERNAL VARIABLES

      //model setter executed upon match selection
      var $setModelValue = $parse(attrs.ngModel).assign;

      //expressions used by typeahead
      var parserResult = typeaheadParser.parse(attrs.typeahead);


      //pop-up element used to display matches
      var popUpEl = angular.element('<typeahead-popup></typeahead-popup>');
      popUpEl.attr({
        matches: 'matches',
        active: 'activeIdx',
        select: 'select(activeIdx)',
        'get-view-value': 'getViewValue()',
        'get-force-open': 'getForceOpen()',
        selection: 'selection()',
        'select-clicked': 'selectClicked()',
        query: 'query',
        position: 'position'
      });
      //custom item template
      if (angular.isDefined(attrs.typeaheadTemplateUrl)) {
        popUpEl.attr('template-url', attrs.typeaheadTemplateUrl);
      }

      //create a child scope for the typeahead directive so we are not polluting original scope
      //with typeahead-specific data (matches, query etc.)
      var scope = originalScope.$new();
      originalScope.$on('$destroy', function(){
        scope.$destroy();
      });

      var resetMatches = function() {
		setForceOpen(originalScope, false);
        scope.matches = [];
        scope.activeIdx = -1;
      };

      /**
       * Load the matches, potentially from a server.
       */
      var getMatchesAsync = function(inputValue) {
        var locals = {$viewValue: inputValue};
        isLoadingSetter(originalScope, true);
        $q.when(parserResult.source(scope, locals)).then(function(matches) {
          //it might happen that several async queries were in progress if a user were typing fast
          //but we are interested only in responses that correspond to the current view value
          var currentValue = modelCtrl.$viewValue;
          if (angular.isUndefined(currentValue)) { currentValue = ''; }
          if (inputValue === currentValue) {
            if (matches.length > 0) {

              scope.activeIdx = 0;
              scope.matches.length = 0;

              //transform labels
              for(var i=0; i<matches.length; i++) {
                locals[parserResult.itemName] = matches[i];
                scope.matches.push({
                  label: parserResult.viewMapper(scope, locals),
                  select: parserResult.modelMapper(originalScope, locals),
                  model: matches[i]
                });
              }

              var model =  modelCtrl.$modelValue;
              var view = parserResult.viewMapper(originalScope, locals);
              if (
                // If there is only one choice and it is an exact match, just select it.
                matches.length == 1 && scope.matches[0].label === inputValue &&
                // But don't do it twice or we could loop indefinitely.
                scope.matches[0].select !== model)
              {
                scope.select(0);
              } else if (matches.length === 0 && !isEditable) {
				scope.clearSelection();
              }

              scope.query = inputValue;
              //position pop-up with matches - we need to re-calculate its position each time we are opening a window
              //with matches as a pop-up might be absolute-positioned and position of an input might have changed on a page
              //due to other elements being rendered
              scope.position = $position.position(element);
              scope.position.top = scope.position.top + element.prop('offsetHeight');
            } else {
              resetMatches();
            }
            isLoadingSetter(originalScope, false);
          }
        }, function(){
          resetMatches();
          isLoadingSetter(originalScope, false);
        });
      };

      resetMatches();

      //we need to propagate user's query so we can higlight matches
      scope.query = undefined;

      //Declare the timeout promise var outside the function scope so that stacked calls can be cancelled later 
      var timeoutPromise;

      //plug into $parsers pipeline to open a typeahead on view changes initiated from DOM
      //$parsers kick-in on all the changes coming from the view as well as manually triggered by $setViewValue
      function updateChoices() {
		var inputValue = modelCtrl.$viewValue;
		if (angular.isUndefined(inputValue)) { inputValue = ''; }
        if (inputValue.length >= minSearch) {
          if (waitTime > 0) {
            if (timeoutPromise) {
              $timeout.cancel(timeoutPromise);//cancel previous timeout
            }
            timeoutPromise = $timeout(function () {
              getMatchesAsync(inputValue);
            }, waitTime);
          } else {
            getMatchesAsync(inputValue);
          }
        }
        return isEditable ? inputValue : undefined;
        //return isEditable ? inputValue : $parse(attrs.ngModel)(originalScope);
      }

      // Open the selections on focus.
      element.on('focus', function() {
		if (!bypassReopen) {
			scope.$apply(updateChoices);
		}
		bypassReopen = false;
      });
      modelCtrl.$parsers.push(updateChoices);

      element.on('blur', function(e) {
        // If not editable and the model is not set, clear the input.
        if (!isEditable && angular.isUndefined(modelCtrl.$modelValue)) {
          scope.blurTimeout = $timeout(function() {
			// Delete the local view value, but don't use modelCtrl.$setViewValue
			// to avoid the callbacks that would pop open the suggestions again.
            element.val(''); delete modelCtrl.$viewValue;
          }, 100);
        }
      });

      modelCtrl.$formatters.push(function (modelValue) {

        var candidateViewValue, emptyViewValue;
        var locals = {};

        if (inputFormatter) {

          locals['$model'] = modelValue;
          return inputFormatter(originalScope, locals);

        } else {

          //it might happen that we don't have enough info to properly render input value
          //we need to check for this situation and simply return model value if we can't apply
          //custom formatting
          locals[parserResult.itemName] = modelValue;
          candidateViewValue = parserResult.viewMapper(originalScope, locals);
          locals[parserResult.itemName] = undefined;
          emptyViewValue = parserResult.viewMapper(originalScope, locals);

          return candidateViewValue!== emptyViewValue ? candidateViewValue : modelValue;
        }
      });

      scope.select = function (activeIdx) {
        //called from within the $digest() cycle
        var locals = {};
        var model, item;
        locals[parserResult.itemName] = item = scope.matches[activeIdx].model;
        model = parserResult.modelMapper(originalScope, locals);
		// Need to call this to set the input (& therefore form) $dirty flag
        modelCtrl.$setViewValue(parserResult.viewMapper(originalScope, locals));
		// This is all that is necessary to call if we didn't have to set the
		// $dirty flag.  Would be nice if NG would let us set $dirty directly.
        $setModelValue(originalScope, model);
		// This is only necessary when we call $setViewValue.  Without that,
		// $setModelValue is enough to update the DOM.  Dunno why we need this
		// now.
		modelCtrl.$render();

        onSelectCallback(originalScope, {
          $item: item,
          $model: model,
          $label: parserResult.viewMapper(originalScope, locals)
        });

        resetMatches();
      };
      scope.clearSelection = function() {
        $setModelValue(originalScope, undefined);
      };
      scope.getViewValue = function() {
		return modelCtrl.$viewValue;
      };
      scope.getForceOpen = function() {
		return getForceOpen(originalScope);
      };
      scope.selection = function() {
        return $parse(attrs.ngModel)(originalScope);
      };

      /**
       * Cancel a blur event since we will be restoring focus to the input
       * field shortly.
       */
      scope.selectClicked = function() {
        if (scope.blurTimeout) {
          $timeout.cancel(scope.blurTimeout);
          delete scope.blurTimeout;
        }

        // Return focus to the input element after a match was selected via a mouse click event
		// Delay this so the focus callback doesn't get called inside $apply.
        setTimeout(function(){bypassReopen = true; element[0].focus();}, 100);
      };

      //bind keyboard events: arrows up(38) / down(40), enter(13) and tab(9), esc(27)
      element.bind('keydown', function (evt) {
        //typeahead is open and an "interesting" key was pressed
        if (
          !(//isOpen
            scope.matches.length > 1 ||
            scope.matches.length == 1 &&
               (scope.matches[0].label !== modelCtrl.$viewValue || getForceOpen(originalScope))
          ) ||
          HOT_KEYS.indexOf(evt.which) === -1) {
          setForceOpen(originalScope, false);
          return;
        }

        if (evt.which === 40) {
          // Down Arrow
          scope.activeIdx = (scope.activeIdx + 1) % scope.matches.length;
          scope.$digest();

        } else if (evt.which === 38) {
          // Up Arrow
          scope.activeIdx = (scope.activeIdx ? scope.activeIdx : scope.matches.length) - 1;
          scope.$digest();

        } else if (evt.which === 13 || evt.which === 9) {
          // Tab or Return
          scope.$apply(function () {
            scope.select(scope.activeIdx);
          });

          // Let tab switch to the next input field after selection.
          if (evt.which == 13) {
            evt.preventDefault();
          }

        } else if (evt.which === 27) {
          // Escape
          evt.stopPropagation();

          resetMatches();
          scope.$digest();
        }
      });

      $document.bind('click', function(e){
		// Clicks in the typeahead input are OK.  Also ignore clicks that come
		// right after a showAll change, assuming that this is the click event
		// that triggered the showAll change.
		if (e.target !== element[0] && !forceOpenChanged) {
			resetMatches();
			scope.$digest();
		}
      });

      element.after($compile(popUpEl)(scope));
    }
  };

}])

  .directive('typeaheadPopup', function ($parse) {
    return {
      restrict:'E',
      scope:{
        matches:'=',
        query:'=',
        active:'=',
        position:'=',
        selectClicked:'&',
        getViewValue:'&',
        getForceOpen:'&',
        selection:'&',
        select:'&'
      },
      replace:true,
      templateUrl:'template/typeahead/typeahead-popup.html',
      link:function (scope, element, attrs) {

        scope.templateUrl = attrs.templateUrl;

        scope.isOpen = function () {
			return (
				scope.matches.length > 1 ||
				scope.matches.length == 1 &&
				(scope.matches[0].label !== scope.getViewValue() || scope.getForceOpen())
			);
        };

        scope.isActive = function (matchIdx) {
          return scope.active == matchIdx;
        };

        scope.selectActive = function (matchIdx) {
          scope.active = matchIdx;
        };

        scope.selectMatch = function (activeIdx) {
          scope.select({activeIdx: activeIdx});
        };
      }
    };
  })

  .directive('typeaheadMatch', ['$http', '$templateCache', '$compile', '$parse', '$sce', function ($http, $templateCache, $compile, $parse, $sce) {
    return {
      restrict:'E',
      scope:{
        index:'=',
        match:'=',
        query:'='
      },
      link:function (scope, element, attrs) {

        var tplUrl = $parse(attrs.templateUrl)(scope.$parent) || 'template/typeahead/typeahead-match.html';
        $http.get(tplUrl, {cache: $templateCache}).success(function(tplContent){
           element.replaceWith($compile(tplContent.trim())(scope));
        });
      }
    };
  }])

  .filter('typeaheadHighlight', function() {

    function escapeRegexp(queryToEscape) {
      return queryToEscape.replace(/([.?*+^$[\]\\(){}|-])/g, "\\$1");
    }

    return function(matchItem, query) {
      return query ? matchItem.replace(new RegExp(escapeRegexp(query), 'gi'), '<strong>$&</strong>') : matchItem;
    };
  })

  .filter('trustHtml', ['$sce', function($sce) {

    return function(html) {
      return $sce.trustAsHtml(html);
    };
  }]);
